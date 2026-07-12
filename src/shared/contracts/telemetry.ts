import { z } from "zod";

export type UsageMetric = Readonly<{
  category: "INPUT" | "OUTPUT" | "CACHED_INPUT" | "REASONING" | "TOTAL";
  units: number | "UNKNOWN";
  modelLabel?: string;
}>;

export const UsageMetricSchema = z
  .object({
    category: z.enum(["INPUT", "OUTPUT", "CACHED_INPUT", "REASONING", "TOTAL"]),
    units: z.union([z.number().int().nonnegative(), z.literal("UNKNOWN")]),
    modelLabel: z.string().min(1).max(120).optional(),
  })
  .strict();

export type AttemptUsageEligibility = Readonly<{
  attemptId: string;
  runtime: string;
  provider: string;
  profileId?: string;
  profileVersion?: number;
  declaredModel?: string;
  startedAt?: number;
  endedAt?: number;
}>;

export type UsageObservation = Readonly<{
  observationId: string;
  attemptId: string;
  runtime: string;
  provider: string;
  modelIdentifier: string;
  category: UsageMetric["category"];
  units: number | "UNKNOWN";
  observedAt: number;
}>;

export type UsageCoverageGroup = Readonly<{
  runtime: string;
  provider: string;
  modelIdentifier: string;
  category: UsageMetric["category"];
  knownUnits: number;
  knownAttempts: number;
  totalAttempts: number;
  coverage: "NONE" | "PARTIAL" | "COMPLETE";
}>;

export type AttemptOperationalFact = Readonly<{
  attemptId: string;
  startedAt?: number;
  terminalAt?: number;
}>;

export type AttemptCauseFact = Readonly<{
  attemptId: string;
  cause: "INITIAL" | "RETRY" | "RESUME" | "MANAGED_LOOP" | "HUMAN_DECISION" | "LEGACY_UNKNOWN";
  managedLoopIteration?: number;
}>;

export type GateOperationalFact = Readonly<{
  gateEvaluationId: string;
  gateKey: string;
  durationMs: number | "UNKNOWN";
}>;

export type CoverageCount = Readonly<{
  knownAttempts: number;
  totalAttempts: number;
  coverage: "NONE" | "PARTIAL" | "COMPLETE";
}>;

export type OperationalUsageSummary = Readonly<{
  attemptCount: number;
  attemptCauses: CoverageCount;
  managedLoopIterationCount: number | "UNKNOWN";
  wallClock: CoverageCount & Readonly<{ knownMilliseconds: number }>;
  gates: readonly Readonly<{
    gateKey: string;
    knownMilliseconds: number;
    knownEvaluations: number;
    totalEvaluations: number;
    coverage: "NONE" | "PARTIAL" | "COMPLETE";
  }>[];
}>;
