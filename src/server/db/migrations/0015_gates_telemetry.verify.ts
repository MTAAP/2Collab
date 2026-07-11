import { Database } from "bun:sqlite";
import migration from "./0015_gates_telemetry.sql" with { type: "text" };

const TABLES = [
  "approved_gate_manifests",
  "gate_evaluations",
  "managed_loop_state",
  "workflow_usage_snapshots",
] as const;
export function verifyGatesTelemetrySchema(database: Database): void {
  const versions = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  if (versions.length < 15 || versions.slice(0, 15).some((row, index) => row.version !== index + 1))
    throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
  for (const table of TABLES)
    if (database.query<{ strict: number }, []>(`PRAGMA table_list('${table}')`).get()?.strict !== 1)
      throw new Error("SCHEMA_INTEGRITY_INVALID");
  const evaluationSql = database
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='gate_evaluations'",
    )
    .get()?.sql;
  const index = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='gate_evaluations_run_revision'",
    )
    .get();
  if (
    !evaluationSql?.includes("json_valid(evidence_json)") ||
    !evaluationSql.includes("completed_at IS NOT NULL") ||
    !index
  )
    throw new Error("SCHEMA_INTEGRITY_INVALID");
}

if (import.meta.main) {
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
    for (let version = 1; version <= 14; version += 1)
      database.query("INSERT INTO schema_migrations VALUES (?,0)").run(version);
    database.exec(migration);
    verifyGatesTelemetrySchema(database);
  } finally {
    database.close();
  }
}
