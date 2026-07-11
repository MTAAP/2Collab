import type { Database } from "bun:sqlite";

export const GITHUB_TABLES = [
  "github_installations",
  "github_project_connectors",
  "github_selected_repositories",
  "github_selected_projects",
  "github_webhook_deliveries",
  "github_webhook_applications",
  "github_source_projections",
  "github_reconciliation_cursors",
] as const;

export const GITHUB_INDEXES = [
  "github_webhook_applications_pending",
  "github_reconciliation_due",
] as const;

export function verifyGitHubSchema(database: Database): void {
  const versions = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => row.version);
  if (versions.length < 7 || versions.slice(0, 7).some((value, index) => value !== index + 1)) {
    throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
  }
  for (const [type, expected] of [
    ["table", GITHUB_TABLES],
    ["index", GITHUB_INDEXES],
  ] as const) {
    const actual = new Set(
      database
        .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = ?")
        .all(type)
        .map((row) => row.name),
    );
    if (expected.some((name) => !actual.has(name))) throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
  for (const table of GITHUB_TABLES) {
    if (
      database.query<{ strict: number }, []>(`PRAGMA table_list('${table}')`).get()?.strict !== 1
    ) {
      throw new Error("SCHEMA_INTEGRITY_INVALID");
    }
  }
  if (
    database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check !== "ok" ||
    database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all().length !== 0
  ) {
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
}
