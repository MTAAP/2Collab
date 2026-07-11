import type { Database } from "bun:sqlite";

export function verifyRepositoryObservationSchema(database: Database): void {
  const versions = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  if (versions.length < 16 || versions.slice(0, 16).some((row, index) => row.version !== index + 1))
    throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
  if (
    database
      .query<{ strict: number }, []>("PRAGMA table_list('runner_repository_observations')")
      .get()?.strict !== 1
  )
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  const foreignKeys = database
    .query<{ table: string; from: string; to: string }, []>(
      "PRAGMA foreign_key_list('runner_repository_observations')",
    )
    .all();
  if (
    !foreignKeys.some(
      (key) =>
        key.table === "runner_mapping_versions" &&
        key.from === "mapping_revision" &&
        key.to === "revision",
    )
  )
    throw new Error("SCHEMA_INTEGRITY_INVALID");
}
