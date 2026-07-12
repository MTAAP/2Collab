import type { Database } from "bun:sqlite";

const TABLES = [
  "auth_registration_policy",
  "auth_registration_rules",
  "auth_email_registration_tickets",
  "auth_email_send_windows",
] as const;

const INDEXES = [
  "one_active_auth_registration_rule",
  "auth_email_registration_ticket_expiry",
] as const;

export function verifyEmailRegistrationPolicySchema(database: Database): void {
  const versions = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  if (versions.length < 18 || versions.slice(0, 18).some((row, index) => row.version !== index + 1))
    throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
  const tables = new Set(
    database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  const indexes = new Set(
    database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name),
  );
  if (TABLES.some((table) => !tables.has(table)) || INDEXES.some((index) => !indexes.has(index)))
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  const policy = database
    .query<{ singleton: number; mode: string; revision: number }, []>(
      "SELECT singleton, mode, revision FROM auth_registration_policy",
    )
    .get();
  if (policy?.singleton !== 1 || policy.mode !== "INVITE_ONLY" || policy.revision < 1)
    throw new Error("SCHEMA_INTEGRITY_INVALID");
}
