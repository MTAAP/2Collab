import type { Database } from "bun:sqlite";

const TABLES = [
  "workflow_executions",
  "workflow_step_occurrences",
  "workflow_launch_intents",
  "workflow_event_receipts",
  "workflow_start_receipts",
  "workflow_join_states",
  "workflow_decisions",
  "workflow_cancellation_outbox",
] as const;

export function verifyWorkflowExecutionSchema(database: Database): void {
  const versions = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  if (versions.length < 14 || versions.slice(0, 14).some((row, index) => row.version !== index + 1))
    throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
  for (const table of TABLES)
    if (database.query<{ strict: number }, []>(`PRAGMA table_list('${table}')`).get()?.strict !== 1)
      throw new Error("SCHEMA_INTEGRITY_INVALID");
  const occurrence = database
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_step_occurrences'",
    )
    .get()?.sql;
  if (!occurrence?.includes("UNIQUE(workflow_execution_id, node_key, occurrence)"))
    throw new Error("SCHEMA_INTEGRITY_INVALID");
}
