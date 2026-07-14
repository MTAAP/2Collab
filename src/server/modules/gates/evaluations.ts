import type { Database } from "bun:sqlite";
import type { GitHubCheckObservation } from "../../../shared/contracts/github.ts";
import {
  type GateEvaluation,
  type LocalGateEvidence,
  LocalGateEvidenceSchema,
} from "../../../shared/contracts/gates.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { GateCoordinator } from "./contract.ts";
import { approveGateFingerprint, isGateFingerprintApproved } from "./fingerprints.ts";
import { parseTrustedGateManifest } from "./manifest.ts";

export type GateEvaluationCommand = Readonly<{
  id: string;
  projectId: string;
  baseRevision: string;
  runId: string;
  repositoryRevision: string;
  gateKey: string;
  manifestFingerprint: string;
  kind: "LOCAL_COMMAND" | "GITHUB_CHECK";
}>;
export type RequiredGitHubCheck = Readonly<{
  repositoryId: string;
  scopeDigest: string;
  checkName: string;
  acceptableConclusions: readonly ("SUCCESS" | "NEUTRAL" | "SKIPPED")[];
}>;
type GateEvaluationRow = Readonly<{
  id: string;
  run_id: string;
  repository_revision: string;
  gate_key: string;
  manifest_fingerprint: string;
  kind: "LOCAL_COMMAND" | "GITHUB_CHECK";
  state: GateEvaluation["state"];
  evidence_json: string;
  created_at: number;
  completed_at: number | null;
}>;
const fail = (
  code: string,
  message: string,
  retry: "NEVER" | "REFRESH" = "NEVER",
): Result<never> => ({ ok: false, error: { code, message, retry } });

function rowToEvaluation(row: {
  id: string;
  run_id: string;
  repository_revision: string;
  gate_key: string;
  manifest_fingerprint: string;
  kind: "LOCAL_COMMAND" | "GITHUB_CHECK";
  state: GateEvaluation["state"];
  created_at: number;
  completed_at: number | null;
}): GateEvaluation {
  return {
    id: row.id,
    runId: row.run_id,
    repositoryRevision: row.repository_revision,
    gateKey: row.gate_key,
    manifestFingerprint: row.manifest_fingerprint,
    kind: row.kind,
    state: row.state,
    createdAt: row.created_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function completedEvaluation(
  command: GateEvaluationCommand,
  state: GateEvaluation["state"],
  completedAt: number,
): GateEvaluation {
  return {
    id: command.id,
    runId: command.runId,
    repositoryRevision: command.repositoryRevision,
    gateKey: command.gateKey,
    manifestFingerprint: command.manifestFingerprint,
    kind: command.kind,
    state,
    createdAt: completedAt,
    completedAt,
  };
}

export function createGateEvaluationStore(
  dependencies: Readonly<{ database: Database; clock: () => number }>,
) {
  return {
    async startLocal(command: GateEvaluationCommand): Promise<Result<GateEvaluation>> {
      if (command.kind !== "LOCAL_COMMAND")
        return fail("GATE_KIND_INVALID", "Gate evaluation kind is invalid.");
      if (
        !isGateFingerprintApproved(dependencies.database, {
          projectId: command.projectId,
          baseRevision: command.baseRevision,
          fingerprint: command.manifestFingerprint,
        })
      )
        return fail(
          "GATE_FINGERPRINT_STALE",
          "Gate manifest fingerprint is not approved.",
          "REFRESH",
        );
      const existing = dependencies.database
        .query<GateEvaluationRow, [string]>("SELECT * FROM gate_evaluations WHERE id=?")
        .get(command.id);
      if (existing) {
        if (
          existing.run_id !== command.runId ||
          existing.repository_revision !== command.repositoryRevision ||
          existing.gate_key !== command.gateKey ||
          existing.manifest_fingerprint !== command.manifestFingerprint ||
          existing.kind !== command.kind
        )
          return fail(
            "GATE_EVALUATION_REPLAY",
            "Gate evaluation identifier was replayed with different inputs.",
          );
        return { ok: true, value: rowToEvaluation(existing) };
      }
      const now = dependencies.clock();
      dependencies.database
        .query(
          `INSERT INTO gate_evaluations(id, run_id, repository_revision, gate_key, manifest_fingerprint, kind, state, evidence_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, 'LOCAL_COMMAND', 'PENDING', '{}', ?, NULL)`,
        )
        .run(
          command.id,
          command.runId,
          command.repositoryRevision,
          command.gateKey,
          command.manifestFingerprint,
          now,
        );
      return {
        ok: true,
        value: {
          id: command.id,
          runId: command.runId,
          repositoryRevision: command.repositoryRevision,
          gateKey: command.gateKey,
          manifestFingerprint: command.manifestFingerprint,
          kind: "LOCAL_COMMAND",
          state: "PENDING",
          createdAt: now,
        },
      };
    },
    async recordLocal(
      command: GateEvaluationCommand,
      candidate: LocalGateEvidence,
    ): Promise<Result<GateEvaluation>> {
      if (command.kind !== "LOCAL_COMMAND")
        return fail("GATE_KIND_INVALID", "Gate evaluation kind is invalid.");
      if (
        !isGateFingerprintApproved(dependencies.database, {
          projectId: command.projectId,
          baseRevision: command.baseRevision,
          fingerprint: command.manifestFingerprint,
        })
      )
        return fail(
          "GATE_FINGERPRINT_STALE",
          "Gate manifest fingerprint is not approved.",
          "REFRESH",
        );
      const evidence = LocalGateEvidenceSchema.safeParse(candidate);
      if (!evidence.success)
        return fail("GATE_EVIDENCE_INVALID", "Local gate evidence is invalid.");
      const existing = dependencies.database
        .query<GateEvaluationRow, [string]>("SELECT * FROM gate_evaluations WHERE id=?")
        .get(command.id);
      if (existing) {
        if (
          existing.run_id !== command.runId ||
          existing.repository_revision !== command.repositoryRevision ||
          existing.gate_key !== command.gateKey ||
          existing.manifest_fingerprint !== command.manifestFingerprint ||
          existing.kind !== command.kind
        )
          return fail(
            "GATE_EVALUATION_REPLAY",
            "Gate evaluation identifier was replayed with different inputs.",
          );
        if (existing.state !== "PENDING" && existing.state !== "RUNNING") {
          if (existing.evidence_json !== JSON.stringify(evidence.data))
            return fail(
              "GATE_EVALUATION_REPLAY",
              "Gate evaluation identifier was replayed with different inputs.",
            );
          return { ok: true, value: rowToEvaluation(existing) };
        }
      }
      const state: GateEvaluation["state"] = evidence.data.cancelled
        ? "CANCELLED"
        : evidence.data.timedOut
          ? "TIMED_OUT"
          : evidence.data.exitCode === 0 && !evidence.data.trackedMutation
            ? "PASSED"
            : "FAILED";
      const now = dependencies.clock();
      if (existing) {
        dependencies.database
          .query(
            `UPDATE gate_evaluations SET state=?, evidence_json=?, completed_at=? WHERE id=? AND state IN ('PENDING','RUNNING')`,
          )
          .run(state, JSON.stringify(evidence.data), now, command.id);
        return {
          ok: true,
          value: { ...completedEvaluation(command, state, now), createdAt: existing.created_at },
        };
      }
      dependencies.database
        .query(
          `INSERT INTO gate_evaluations(id, run_id, repository_revision, gate_key, manifest_fingerprint, kind, state, evidence_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          command.id,
          command.runId,
          command.repositoryRevision,
          command.gateKey,
          command.manifestFingerprint,
          command.kind,
          state,
          JSON.stringify(evidence.data),
          now,
          now,
        );
      return { ok: true, value: completedEvaluation(command, state, now) };
    },
    async recordGitHub(
      command: GateEvaluationCommand,
      observation: GitHubCheckObservation,
      required: RequiredGitHubCheck,
    ): Promise<Result<GateEvaluation>> {
      if (
        !isGateFingerprintApproved(dependencies.database, {
          projectId: command.projectId,
          baseRevision: command.baseRevision,
          fingerprint: command.manifestFingerprint,
        })
      )
        return fail(
          "GATE_FINGERPRINT_STALE",
          "Gate manifest fingerprint is not approved.",
          "REFRESH",
        );
      const existing = dependencies.database
        .query<GateEvaluationRow, [string]>("SELECT * FROM gate_evaluations WHERE id=?")
        .get(command.id);
      if (existing) {
        if (
          existing.run_id !== command.runId ||
          existing.repository_revision !== command.repositoryRevision ||
          existing.gate_key !== command.gateKey ||
          existing.manifest_fingerprint !== command.manifestFingerprint ||
          existing.kind !== command.kind
        )
          return fail(
            "GATE_EVALUATION_REPLAY",
            "Gate evaluation identifier was replayed with different inputs.",
          );
        if (existing.state !== "PENDING") {
          const prior = JSON.parse(existing.evidence_json) as {
            checkRunId?: string;
            status?: string;
            conclusion?: string | null;
            observedAt?: number;
          };
          if (
            prior.checkRunId !== observation.checkRunId ||
            prior.status !== observation.status ||
            prior.conclusion !== observation.conclusion ||
            prior.observedAt !== observation.observedAt
          )
            return fail(
              "GATE_EVALUATION_REPLAY",
              "Gate evaluation identifier was replayed with different inputs.",
            );
          return { ok: true, value: rowToEvaluation(existing) };
        }
      }
      if (observation.commitSha !== command.repositoryRevision)
        return fail("GATE_REVISION_STALE", "GitHub check revision is stale.", "REFRESH");
      if (
        !observation.fresh ||
        observation.repositoryId !== required.repositoryId ||
        observation.scopeDigest !== required.scopeDigest ||
        observation.checkName !== required.checkName
      )
        return fail("GATE_EVALUATION_STALE", "GitHub check observation is stale.", "REFRESH");
      const state: GateEvaluation["state"] =
        observation.status !== "COMPLETED"
          ? "PENDING"
          : observation.conclusion &&
              required.acceptableConclusions.includes(observation.conclusion as never)
            ? "PASSED"
            : observation.conclusion === "CANCELLED"
              ? "CANCELLED"
              : observation.conclusion === "TIMED_OUT"
                ? "TIMED_OUT"
                : "FAILED";
      const now = dependencies.clock();
      const evidence = JSON.stringify({
        checkRunId: observation.checkRunId,
        repositoryId: observation.repositoryId,
        commitSha: observation.commitSha,
        checkName: observation.checkName,
        status: observation.status,
        conclusion: observation.conclusion,
        observedAt: observation.observedAt,
      });
      if (existing)
        dependencies.database
          .query(
            `UPDATE gate_evaluations SET state=?, evidence_json=?, completed_at=?
             WHERE id=? AND state='PENDING'`,
          )
          .run(state, evidence, state === "PENDING" ? null : now, command.id);
      else
        dependencies.database
          .query(
            `INSERT INTO gate_evaluations(id, run_id, repository_revision, gate_key, manifest_fingerprint, kind, state, evidence_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            command.id,
            command.runId,
            command.repositoryRevision,
            command.gateKey,
            command.manifestFingerprint,
            command.kind,
            state,
            evidence,
            now,
            state === "PENDING" ? null : now,
          );
      return state === "PENDING"
        ? {
            ok: true,
            value: {
              id: command.id,
              runId: command.runId,
              repositoryRevision: command.repositoryRevision,
              gateKey: command.gateKey,
              manifestFingerprint: command.manifestFingerprint,
              kind: command.kind,
              state,
              createdAt: existing?.created_at ?? now,
            },
          }
        : {
            ok: true,
            value: {
              ...completedEvaluation(command, state, now),
              createdAt: existing?.created_at ?? now,
            },
          };
    },
  };
}

export function createGateCoordinator(
  dependencies: Readonly<{ database: Database; clock: () => number }>,
): GateCoordinator {
  const store = createGateEvaluationStore(dependencies);
  return {
    async inspectManifest(query) {
      const parsed = parseTrustedGateManifest(query);
      return parsed.ok ? { ok: true, value: parsed.value.summary } : parsed;
    },
    async approveFingerprint(command) {
      const runnerTable = dependencies.database
        .query<{ present: number }, []>(
          "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='runners'",
        )
        .get();
      if (
        !runnerTable ||
        !dependencies.database
          .query<{ present: number }, [string, string]>(
            `SELECT 1 AS present FROM runners
             WHERE id = ? AND owner_member_id = ? AND revoked_at IS NULL`,
          )
          .get(command.runnerId, command.approvedByRunnerOwnerId)
      )
        return fail(
          "RUNNER_OWNER_REQUIRED",
          "Only the active runner owner may approve a gate fingerprint.",
        );
      const approved = approveGateFingerprint(dependencies.database, command);
      return approved.ok
        ? { ok: true, value: { fingerprint: approved.value.fingerprint } }
        : approved;
    },
    async evaluate(command) {
      if (command.manifestSource !== "TRUSTED_BASE")
        return {
          ok: false,
          error: {
            code: "GATE_MANIFEST_UNTRUSTED",
            message: "Gate manifest is not from the trusted base revision.",
            retry: "NEVER",
          },
        };
      const binding: GateEvaluationCommand = {
        id: command.id,
        projectId: command.projectId,
        baseRevision: command.baseRevision,
        runId: command.runId,
        repositoryRevision: command.repositoryRevision,
        gateKey: command.gateKey,
        manifestFingerprint: command.manifestFingerprint,
        kind: command.kind,
      };
      if (command.kind === "LOCAL_COMMAND") {
        if (command.localEvidence) {
          if (
            command.runnerActor?.kind !== "RUNNER" ||
            !command.sessionId ||
            !Number.isInteger(command.sessionFence) ||
            (command.sessionFence ?? 0) < 1 ||
            !command.idempotencyKey
          )
            return fail(
              "GATE_RUNNER_EVIDENCE_REQUIRED",
              "Authenticated runner gate evidence is required.",
            );
          const authenticated = dependencies.database
            .query<{ present: number }, [string, string, number, number, number, string, number]>(
              `SELECT 1 AS present
               FROM authority_sessions AS sessions
               JOIN execution_attempts AS attempts ON attempts.id = sessions.attempt_id
               JOIN runners ON runners.id = sessions.runner_id
               WHERE sessions.id = ? AND sessions.runner_id = ? AND sessions.runner_epoch = ?
                 AND sessions.fence = ? AND sessions.state = 'ACTIVE' AND sessions.expires_at > ?
                 AND attempts.run_id = ? AND runners.runner_epoch = ?
                 AND runners.revoked_at IS NULL`,
            )
            .get(
              command.sessionId,
              command.runnerActor.runnerId,
              command.runnerActor.runnerEpoch,
              command.sessionFence as number,
              dependencies.clock(),
              command.runId,
              command.runnerActor.runnerEpoch,
            );
          if (!authenticated)
            return fail(
              "GATE_RUNNER_EVIDENCE_STALE",
              "Runner gate evidence authority is stale.",
              "REFRESH",
            );
        }
        return command.localEvidence
          ? store.recordLocal(binding, command.localEvidence)
          : store.startLocal(binding);
      }
      if (!command.checkObservation || !command.requiredGitHubCheck)
        return fail("GATE_EVIDENCE_INVALID", "GitHub gate evidence is unavailable.", "REFRESH");
      return store.recordGitHub(binding, command.checkObservation, command.requiredGitHubCheck);
    },
  };
}
