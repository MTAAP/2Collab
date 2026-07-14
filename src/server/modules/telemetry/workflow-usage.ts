export type AttemptUsage = Readonly<{
  inputUnits: number | "UNKNOWN";
  outputUnits: number | "UNKNOWN";
  runtimeMs: number;
  category: string;
}>;
export type GateUsage = Readonly<{ durationMs: number }>;
import type { Database } from "bun:sqlite";

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

export function createWorkflowUsageStore(
  dependencies: Readonly<{ database: Database; clock: () => number }>,
) {
  return {
    record(
      workflowExecutionId: string,
      revision: number,
      attempts: readonly AttemptUsage[],
      gates: readonly GateUsage[],
    ) {
      const usage = aggregateWorkflowUsage(attempts, gates);
      dependencies.database
        .query<
          void,
          [string, number, string, number, number, string, number, number, number, number, number]
        >(
          `INSERT INTO workflow_usage_snapshots(
             workflow_execution_id, revision, coverage_status, known_attempts,
             total_attempts, usage_category, known_input_units, known_output_units,
             runtime_ms, gate_ms, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workflowExecutionId,
          revision,
          usage.coverage.status,
          usage.coverage.knownAttempts,
          usage.coverage.totalAttempts,
          usage.known.category,
          usage.known.inputUnits,
          usage.known.outputUnits,
          usage.runtimeMs,
          usage.gateMs,
          dependencies.clock(),
        );
      return usage;
    },
  };
}
