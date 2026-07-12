import type { Database } from "bun:sqlite";
export function verifyGitHubAttentionSchema(database: Database): void {
  const versions = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  if (versions.length < 9 || versions.slice(0, 9).some((row, index) => row.version !== index + 1))
    throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
  if (
    database.query<{ strict: number }, []>("PRAGMA table_list('inbox_items')").get()?.strict !== 1
  )
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  for (const index of ["inbox_items_recipient_unread_idx", "inbox_items_resolved_retention_idx"])
    if (!database.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index))
      throw new Error("SCHEMA_INTEGRITY_INVALID");
}
