import type { Database } from "bun:sqlite";

export const RUNNER_TABLES = [
  "runners",
  "runner_pairings",
  "runner_credentials",
  "runner_mapping_versions",
  "safe_profile_versions",
  "runner_exposure_acknowledgements",
  "runner_exposures",
  "runner_authority_change_outbox",
] as const;

export const RUNNER_INDEXES = [
  "one_active_runner_credential",
  "one_active_runner_mapping",
  "one_active_runner_exposure",
] as const;
export const RUNNER_TRIGGERS = [
  "runners_owner_immutable",
  "runner_mapping_facts_immutable",
  "safe_profile_versions_append_only",
  "runner_acknowledgement_content_immutable",
] as const;

export function verifyRunnersSchema(database: Database): void {
  const versions = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  if (versions.map((row) => row.version).join(",") !== "1,2,3") {
    throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
  }
  for (const [type, expected] of [
    ["table", RUNNER_TABLES],
    ["index", RUNNER_INDEXES],
    ["trigger", RUNNER_TRIGGERS],
  ] as const) {
    const names = new Set(
      database
        .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = ?")
        .all(type)
        .map((row) => row.name),
    );
    if (expected.some((name) => !names.has(name))) throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
  for (const table of RUNNER_TABLES) {
    if (
      database.query<{ strict: number }, []>(`PRAGMA table_list('${table}')`).get()?.strict !== 1
    ) {
      throw new Error("SCHEMA_INTEGRITY_INVALID");
    }
  }
  if (
    database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check !== "ok"
  ) {
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
  if (database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all().length !== 0) {
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
}
