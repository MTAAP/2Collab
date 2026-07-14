import type { Database } from "bun:sqlite";
import type { Result } from "../../../shared/contracts/result.ts";
import type {
  AttemptCauseFact,
  AttemptOperationalFact,
  AttemptUsageEligibility,
  GateOperationalFact,
  OperationalUsageSummary,
  UsageCoverageGroup,
  UsageObservation,
} from "../../../shared/contracts/telemetry.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";

function dimension(observation: UsageObservation): string {
  return JSON.stringify([
    observation.runtime,
    observation.provider,
    observation.modelIdentifier,
    observation.category,
  ]);
}

export function aggregateUsage(
  eligibleAttempts: readonly AttemptUsageEligibility[],
  observations: readonly UsageObservation[],
): readonly UsageCoverageGroup[] {
  const eligible = new Map<string, AttemptUsageEligibility>();
  for (const attempt of eligibleAttempts) {
    if (!eligible.has(attempt.attemptId)) eligible.set(attempt.attemptId, attempt);
  }
  const seenObservationIds = new Set<string>();
  const reportedModels = new Map<string, Set<string>>();
  const groups = new Map<
    string,
    {
      prototype: UsageObservation;
      knownUnits: number;
      knownAttempts: Set<string>;
    }
  >();

  for (const observation of observations) {
    const observationKey = JSON.stringify([
      observation.attemptId,
      observation.observationId,
      observation.category,
    ]);
    if (seenObservationIds.has(observationKey)) continue;
    seenObservationIds.add(observationKey);
    const attempt = eligible.get(observation.attemptId);
    if (
      !attempt ||
      attempt.runtime !== observation.runtime ||
      attempt.provider !== observation.provider ||
      !Number.isInteger(observation.observedAt) ||
      observation.observedAt < 0 ||
      (observation.units !== "UNKNOWN" &&
        (!Number.isInteger(observation.units) || observation.units < 0))
    ) {
      continue;
    }
    const key = dimension(observation);
    const attemptModels = reportedModels.get(observation.attemptId) ?? new Set<string>();
    attemptModels.add(observation.modelIdentifier);
    reportedModels.set(observation.attemptId, attemptModels);
    const group = groups.get(key) ?? {
      prototype: observation,
      knownUnits: 0,
      knownAttempts: new Set<string>(),
    };
    if (observation.units !== "UNKNOWN") {
      group.knownUnits += observation.units;
      group.knownAttempts.add(observation.attemptId);
    }
    groups.set(key, group);
  }

  return [...groups.values()]
    .map(({ prototype, knownUnits, knownAttempts }) => {
      const totalAttempts = [...eligible.values()].filter((attempt) => {
        if (attempt.runtime !== prototype.runtime || attempt.provider !== prototype.provider) {
          return false;
        }
        const models = reportedModels.get(attempt.attemptId);
        if (models && models.size > 0) return models.has(prototype.modelIdentifier);
        return (
          attempt.declaredModel === undefined || attempt.declaredModel === prototype.modelIdentifier
        );
      }).length;
      const knownCount = knownAttempts.size;
      return {
        runtime: prototype.runtime,
        provider: prototype.provider,
        modelIdentifier: prototype.modelIdentifier,
        category: prototype.category,
        knownUnits,
        knownAttempts: knownCount,
        totalAttempts,
        coverage:
          knownCount === 0
            ? ("NONE" as const)
            : knownCount === totalAttempts
              ? ("COMPLETE" as const)
              : ("PARTIAL" as const),
      };
    })
    .sort(
      (left, right) =>
        left.runtime.localeCompare(right.runtime) ||
        left.provider.localeCompare(right.provider) ||
        left.modelIdentifier.localeCompare(right.modelIdentifier) ||
        left.category.localeCompare(right.category),
    );
}

function coverage(known: number, total: number): "NONE" | "PARTIAL" | "COMPLETE" {
  if (known === 0) return "NONE";
  return known === total ? "COMPLETE" : "PARTIAL";
}

export function aggregateOperationalUsage(
  attempts: readonly AttemptOperationalFact[],
  causes: readonly AttemptCauseFact[],
  gateFacts: readonly GateOperationalFact[],
): OperationalUsageSummary {
  const uniqueAttempts = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
  const uniqueCauses = new Map(causes.map((cause) => [cause.attemptId, cause]));
  let knownWallClockAttempts = 0;
  let knownMilliseconds = 0;
  for (const attempt of uniqueAttempts.values()) {
    if (
      attempt.startedAt !== undefined &&
      attempt.terminalAt !== undefined &&
      Number.isInteger(attempt.startedAt) &&
      Number.isInteger(attempt.terminalAt) &&
      attempt.startedAt >= 0 &&
      attempt.terminalAt >= attempt.startedAt
    ) {
      knownWallClockAttempts += 1;
      knownMilliseconds += attempt.terminalAt - attempt.startedAt;
    }
  }
  const knownCauses = [...uniqueAttempts.keys()].filter((attemptId) => {
    const cause = uniqueCauses.get(attemptId);
    return cause !== undefined && cause.cause !== "LEGACY_UNKNOWN";
  }).length;
  const loopCountKnown = knownCauses === uniqueAttempts.size;
  const managedLoopIterationCount = loopCountKnown
    ? [...uniqueAttempts.keys()].filter(
        (attemptId) => uniqueCauses.get(attemptId)?.cause === "MANAGED_LOOP",
      ).length
    : "UNKNOWN";

  const gateGroups = new Map<string, { knownMilliseconds: number; known: number; total: number }>();
  const seenGateEvaluations = new Set<string>();
  for (const fact of gateFacts) {
    if (seenGateEvaluations.has(fact.gateEvaluationId)) continue;
    seenGateEvaluations.add(fact.gateEvaluationId);
    const group = gateGroups.get(fact.gateKey) ?? { knownMilliseconds: 0, known: 0, total: 0 };
    group.total += 1;
    if (
      fact.durationMs !== "UNKNOWN" &&
      Number.isInteger(fact.durationMs) &&
      fact.durationMs >= 0
    ) {
      group.known += 1;
      group.knownMilliseconds += fact.durationMs;
    }
    gateGroups.set(fact.gateKey, group);
  }

  return {
    attemptCount: uniqueAttempts.size,
    attemptCauses: {
      knownAttempts: knownCauses,
      totalAttempts: uniqueAttempts.size,
      coverage: coverage(knownCauses, uniqueAttempts.size),
    },
    managedLoopIterationCount,
    wallClock: {
      knownMilliseconds,
      knownAttempts: knownWallClockAttempts,
      totalAttempts: uniqueAttempts.size,
      coverage: coverage(knownWallClockAttempts, uniqueAttempts.size),
    },
    gates: [...gateGroups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([gateKey, group]) => ({
        gateKey,
        knownMilliseconds: group.knownMilliseconds,
        knownEvaluations: group.known,
        totalEvaluations: group.total,
        coverage: coverage(group.known, group.total),
      })),
  };
}

function usageError<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

const categoryToStorage = {
  INPUT: "INPUT_UNITS",
  OUTPUT: "OUTPUT_UNITS",
  CACHED_INPUT: "CACHED_INPUT_UNITS",
  REASONING: "REASONING_UNITS",
  TOTAL: "TOTAL_UNITS",
} as const;

const categoryFromStorage = {
  INPUT_UNITS: "INPUT",
  OUTPUT_UNITS: "OUTPUT",
  CACHED_INPUT_UNITS: "CACHED_INPUT",
  REASONING_UNITS: "REASONING",
  TOTAL_UNITS: "TOTAL",
} as const;

export function createUsageStore(
  dependencies: Readonly<{
    database: Database;
    clock: () => number;
    id: (prefix: string) => string;
  }>,
) {
  const eligibleAttempts = (): readonly AttemptUsageEligibility[] =>
    dependencies.database
      .query<
        {
          attempt_id: string;
          runtime_adapter: string;
          provider: string;
          profile_id: string;
          profile_version: number;
          declared_model: string | null;
          started_at: number | null;
          ended_at: number | null;
        },
        []
      >(
        `SELECT attempt_id, runtime_adapter, provider, profile_id, profile_version,
                declared_model, started_at, ended_at
         FROM attempt_usage_eligibility ORDER BY created_at, attempt_id`,
      )
      .all()
      .map((row) => ({
        attemptId: row.attempt_id,
        runtime: row.runtime_adapter,
        provider: row.provider,
        profileId: row.profile_id,
        profileVersion: row.profile_version,
        ...(row.declared_model ? { declaredModel: row.declared_model } : {}),
        ...(row.started_at === null ? {} : { startedAt: row.started_at }),
        ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      }));

  const observations = (): readonly UsageObservation[] =>
    dependencies.database
      .query<
        {
          observation_id: string;
          attempt_id: string;
          runtime_adapter: string;
          provider: string;
          reported_model: string | null;
          metric_category: keyof typeof categoryFromStorage;
          availability: "KNOWN" | "UNKNOWN";
          units: number | null;
          observed_at: number;
        },
        []
      >(
        `SELECT observations.observation_id, observations.attempt_id,
                eligibility.runtime_adapter, eligibility.provider,
                observations.reported_model, observations.metric_category,
                observations.availability, observations.units, observations.observed_at
         FROM usage_observations AS observations
         JOIN attempt_usage_eligibility AS eligibility
           ON eligibility.attempt_id = observations.attempt_id
         ORDER BY observations.observed_at, observations.id`,
      )
      .all()
      .map((row) => ({
        observationId: row.observation_id,
        attemptId: row.attempt_id,
        runtime: row.runtime_adapter,
        provider: row.provider,
        modelIdentifier: row.reported_model ?? "UNKNOWN",
        category: categoryFromStorage[row.metric_category],
        units: row.availability === "KNOWN" ? (row.units as number) : "UNKNOWN",
        observedAt: row.observed_at,
      }));

  return {
    recordEligibleAttempt(input: AttemptUsageEligibility): Result<AttemptUsageEligibility> {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.attemptId) ||
        !["CLAUDE", "CODEX", "PI", "OPENCODE"].includes(input.runtime) ||
        input.provider.length === 0 ||
        input.provider.length > 64 ||
        !input.profileId ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.profileId) ||
        !Number.isInteger(input.profileVersion) ||
        (input.profileVersion as number) <= 0 ||
        (input.declaredModel?.length ?? 0) > 128 ||
        (input.startedAt !== undefined &&
          (!Number.isInteger(input.startedAt) || input.startedAt < 0)) ||
        (input.endedAt !== undefined &&
          (!Number.isInteger(input.endedAt) ||
            input.endedAt < 0 ||
            input.endedAt < (input.startedAt ?? 0)))
      ) {
        return usageError("USAGE_ELIGIBILITY_INVALID", "Usage eligibility is invalid.");
      }
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const prior = dependencies.database
            .query<
              {
                runtime_adapter: string;
                provider: string;
                profile_id: string;
                profile_version: number;
                declared_model: string | null;
                started_at: number | null;
                ended_at: number | null;
              },
              [string]
            >(
              `SELECT runtime_adapter, provider, profile_id, profile_version, declared_model,
                      started_at, ended_at
               FROM attempt_usage_eligibility WHERE attempt_id = ?`,
            )
            .get(input.attemptId);
          if (prior) {
            const exact =
              prior.runtime_adapter === input.runtime &&
              prior.provider === input.provider &&
              prior.profile_id === input.profileId &&
              prior.profile_version === input.profileVersion &&
              prior.declared_model === (input.declaredModel ?? null) &&
              prior.started_at === (input.startedAt ?? null) &&
              prior.ended_at === (input.endedAt ?? null);
            return exact
              ? { ok: true as const, value: input }
              : usageError(
                  "USAGE_ELIGIBILITY_CONFLICT",
                  "Usage eligibility was already recorded differently.",
                );
          }
          dependencies.database
            .query<
              void,
              [
                string,
                string,
                string,
                string,
                number,
                string | null,
                number | null,
                number | null,
                number,
              ]
            >(
              `INSERT INTO attempt_usage_eligibility(
                 attempt_id, runtime_adapter, provider, profile_id, profile_version,
                 declared_model, started_at, ended_at, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.attemptId,
              input.runtime,
              input.provider,
              input.profileId as string,
              input.profileVersion as number,
              input.declaredModel ?? null,
              input.startedAt ?? null,
              input.endedAt ?? null,
              dependencies.clock(),
            );
          return { ok: true as const, value: input };
        });
      } catch {
        return usageError("USAGE_STORAGE_FAILED", "Usage eligibility could not be stored.");
      }
    },

    appendObservation(input: UsageObservation): Result<UsageObservation> {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.observationId) ||
        input.modelIdentifier.length === 0 ||
        input.modelIdentifier.length > 128 ||
        !Number.isInteger(input.observedAt) ||
        input.observedAt < 0 ||
        (input.units !== "UNKNOWN" && (!Number.isInteger(input.units) || input.units < 0))
      ) {
        return usageError("USAGE_OBSERVATION_INVALID", "Usage observation is invalid.");
      }
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const eligibility = dependencies.database
            .query<{ runtime_adapter: string; provider: string }, [string]>(
              `SELECT runtime_adapter, provider FROM attempt_usage_eligibility
               WHERE attempt_id = ?`,
            )
            .get(input.attemptId);
          if (
            !eligibility ||
            eligibility.runtime_adapter !== input.runtime ||
            eligibility.provider !== input.provider
          ) {
            return usageError(
              "USAGE_OBSERVATION_PROVENANCE_INVALID",
              "Usage observation provenance is invalid.",
            );
          }
          const storedCategory = categoryToStorage[input.category];
          const prior = dependencies.database
            .query<
              {
                provider: string | null;
                reported_model: string | null;
                availability: "KNOWN" | "UNKNOWN";
                units: number | null;
                observed_at: number;
              },
              [string, string, string]
            >(
              `SELECT provider, reported_model, availability, units, observed_at
               FROM usage_observations
               WHERE attempt_id = ? AND observation_id = ? AND metric_category = ?`,
            )
            .get(input.attemptId, input.observationId, storedCategory);
          if (prior) {
            const exact =
              prior.provider === input.provider &&
              prior.reported_model === input.modelIdentifier &&
              prior.availability === (input.units === "UNKNOWN" ? "UNKNOWN" : "KNOWN") &&
              prior.units === (input.units === "UNKNOWN" ? null : input.units) &&
              prior.observed_at === input.observedAt;
            return exact
              ? { ok: true as const, value: input }
              : usageError(
                  "USAGE_OBSERVATION_CONFLICT",
                  "Usage observation was already recorded differently.",
                );
          }
          dependencies.database
            .query<
              void,
              [string, string, string, string, string, string, string, number | null, number]
            >(
              `INSERT INTO usage_observations(
                 id, attempt_id, observation_id, provider, reported_model, metric_category,
                 availability, units, observed_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              dependencies.id("usage"),
              input.attemptId,
              input.observationId,
              input.provider,
              input.modelIdentifier,
              storedCategory,
              input.units === "UNKNOWN" ? "UNKNOWN" : "KNOWN",
              input.units === "UNKNOWN" ? null : input.units,
              input.observedAt,
            );
          return { ok: true as const, value: input };
        });
      } catch {
        return usageError("USAGE_STORAGE_FAILED", "Usage observation could not be stored.");
      }
    },

    eligibleAttempts,
    observations,
    aggregate() {
      return aggregateUsage(eligibleAttempts(), observations());
    },
  };
}
