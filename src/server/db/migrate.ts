import type { Database } from "bun:sqlite";
import foundationMigration from "./migrations/0001_foundation.sql" with { type: "text" };
import { inImmediateTransaction } from "./transaction.ts";

const LATEST_SCHEMA_VERSION = 1;
const FOUNDATION_TABLES = [
  "audit_events",
  "connector_epochs",
  "deployments",
  "encrypted_credentials",
  "idempotency_results",
  "invitation_exchange_sessions",
  "invitations",
  "member_credentials",
  "members",
  "passkey_credential_transports",
  "passkey_credentials",
  "projects",
  "recovery_code_sets",
  "recovery_codes",
  "schema_migrations",
  "sessions",
  "webauthn_challenges",
] as const;

type SchemaVersion = Readonly<{ version: number }>;

function readMigrationHistory(database: Database): readonly SchemaVersion[] {
  return database
    .query<SchemaVersion, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
}

function validateMigrationHistory(versions: readonly SchemaVersion[]): void {
  for (const [index, row] of versions.entries()) {
    if (row.version !== index + 1) {
      throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
    }
  }
}

function validateClaimedSchema(database: Database, version: number): void {
  if (version < 1) return;
  const tables = new Set(
    database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  if (FOUNDATION_TABLES.some((table) => !tables.has(table))) {
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
}

function ensureMigrationLedger(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
    ) STRICT
  `);
}

export function migrate(database: Database): void {
  database.exec("PRAGMA foreign_keys = ON");
  inImmediateTransaction(database, () => {
    ensureMigrationLedger(database);
    const versions = readMigrationHistory(database);
    validateMigrationHistory(versions);
    const currentVersion = versions.at(-1)?.version ?? 0;

    if (currentVersion > LATEST_SCHEMA_VERSION) {
      throw new Error("SCHEMA_VERSION_NEWER_THAN_SUPPORTED");
    }
    if (currentVersion === LATEST_SCHEMA_VERSION) {
      validateClaimedSchema(database, currentVersion);
      return;
    }

    database.exec(foundationMigration);
    const appliedVersions = readMigrationHistory(database);
    validateMigrationHistory(appliedVersions);
    validateClaimedSchema(database, LATEST_SCHEMA_VERSION);
  });
}
