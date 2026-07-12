import type { Database } from "bun:sqlite";

const TABLES = [
  "auth_users",
  "auth_sessions",
  "auth_accounts",
  "auth_verifications",
  "auth_passkeys",
  "auth_device_codes",
  "auth_member_links",
  "auth_registration_tickets",
] as const;

export function verifyBetterAuthSchema(database: Database): void {
  const versions = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  if (versions.length < 17 || versions.slice(0, 17).some((row, index) => row.version !== index + 1))
    throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
  const tables = new Set(
    database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  if (TABLES.some((table) => !tables.has(table))) throw new Error("SCHEMA_INTEGRITY_INVALID");
  const sessionColumns = new Set(
    database
      .query<{ name: string }, []>("PRAGMA table_info('auth_sessions')")
      .all()
      .map((row) => row.name),
  );
  if (
    ["purpose", "memberAuthorityEpoch", "absoluteExpiresAt"].some(
      (column) => !sessionColumns.has(column),
    )
  )
    throw new Error("SCHEMA_INTEGRITY_INVALID");
}
