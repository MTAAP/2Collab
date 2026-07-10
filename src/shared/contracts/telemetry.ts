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
