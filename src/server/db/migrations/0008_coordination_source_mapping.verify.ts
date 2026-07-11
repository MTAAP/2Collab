import type { Database } from "bun:sqlite";

export const COORDINATION_MAPPING_TABLES = [
  "github_source_aliases",
  "coordination_record_aliases",
] as const;

export function verifyCoordinationSourceMappingSchema(database: Database): void {
  const versions = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  if (versions.length < 8 || versions.slice(0, 8).some((row, index) => row.version !== index + 1))
    throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
  for (const table of COORDINATION_MAPPING_TABLES) {
    if (database.query<{ strict: number }, []>(`PRAGMA table_list('${table}')`).get()?.strict !== 1)
      throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
  for (const trigger of [
    "coordination_record_alias_immutable",
    "coordination_record_alias_no_chain",
  ]) {
    if (
      !database
        .query("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get(trigger)
    )
      throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
  if (database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all().length)
    throw new Error("SCHEMA_INTEGRITY_INVALID");
}
