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
