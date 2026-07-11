export type AttemptUsage = Readonly<{
  inputUnits: number | "UNKNOWN";
  outputUnits: number | "UNKNOWN";
  runtimeMs: number;
  category: string;
}>;
export type GateUsage = Readonly<{ durationMs: number }>;

export function aggregateWorkflowUsage(
  attempts: readonly AttemptUsage[],
  gates: readonly GateUsage[],
) {
  const categories = new Set(attempts.map((item) => item.category));
  if (categories.size > 1) throw new Error("WORKFLOW_USAGE_CATEGORY_INCOMPATIBLE");
  const known = attempts.filter(
    (item): item is AttemptUsage & Readonly<{ inputUnits: number; outputUnits: number }> =>
      item.inputUnits !== "UNKNOWN" && item.outputUnits !== "UNKNOWN",
  );
  return {
    coverage: {
      knownAttempts: known.length,
      totalAttempts: attempts.length,
      status: known.length === attempts.length ? ("COMPLETE" as const) : ("PARTIAL" as const),
    },
    known: {
      inputUnits: known.reduce((sum, item) => sum + item.inputUnits, 0),
      outputUnits: known.reduce((sum, item) => sum + item.outputUnits, 0),
      category: attempts[0]?.category ?? "UNKNOWN",
    },
    runtimeMs: attempts.reduce((sum, item) => sum + item.runtimeMs, 0),
    gateMs: gates.reduce((sum, item) => sum + item.durationMs, 0),
  };
}
