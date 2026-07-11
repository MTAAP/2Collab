import type { Database } from "bun:sqlite";
import foundationMigration from "./migrations/0001_foundation.sql" with { type: "text" };
import projectsMigration from "./migrations/0002_projects.sql" with { type: "text" };
import { inImmediateTransaction } from "./transaction.ts";

const LATEST_SCHEMA_VERSION = 2;
const FOUNDATION_TABLES = [
  "audit_events",
  "auth_proxy_replays",
  "authority_revocation_outbox",
  "connector_idempotency",
  "connector_operation_authorizations",
  "connector_operation_intents",
  "connector_projections",
  "connector_scope_operations",
  "connector_scope_references",
  "connector_scopes",
  "connector_epochs",
  "deployments",
  "device_access_tokens",
  "device_authorization_codes",
  "device_credential_families",
  "dpop_replays",
  "encrypted_credentials",
  "idempotency_results",
  "invitation_exchange_sessions",
  "invitations",
  "member_credentials",
  "members",
  "host_recovery_codes",
  "oidc_transactions",
  "passkey_credential_transports",
  "passkey_credentials",
  "projects",
  "recovery_code_sets",
  "recovery_codes",
  "schema_migrations",
  "sessions",
  "source_reconciliation_idempotency",
  "webauthn_challenges",
] as const;
const FOUNDATION_INDEXES = [
  "connector_operation_intents_recovery",
  "one_active_host_recovery_per_owner",
  "one_active_device_family",
  "one_active_recovery_code_set_per_member",
  "sessions_active_member",
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
  const indexes = new Set(
    database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name),
  );
  if (
    FOUNDATION_TABLES.some((table) => !tables.has(table)) ||
    FOUNDATION_INDEXES.some((index) => !indexes.has(index))
  ) {
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
  if (version >= 2) {
    const projectColumns = new Set(
      database
        .query<{ name: string }, []>("PRAGMA table_info(projects)")
        .all()
        .map((row) => row.name),
    );
    const projectTable = database
      .query<{ strict: number }, []>("PRAGMA table_list('projects')")
      .get();
    const projectSql = database
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
      )
      .get()?.sql;
    if (
      !projectColumns.has("base_branch") ||
      projectTable?.strict !== 1 ||
      !projectSql?.includes("base_branch TEXT NOT NULL") ||
      !projectSql.includes("name = trim(name)")
    ) {
      throw new Error("SCHEMA_INTEGRITY_INVALID");
    }
  }
  const integrity = database.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
  const foreignKeyFailures = database
    .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
    .all();
  if (integrity?.quick_check !== "ok" || foreignKeyFailures.length !== 0) {
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
    let currentVersion = versions.at(-1)?.version ?? 0;

    if (currentVersion > LATEST_SCHEMA_VERSION) {
      throw new Error("SCHEMA_VERSION_NEWER_THAN_SUPPORTED");
    }
    if (currentVersion === LATEST_SCHEMA_VERSION) {
      validateClaimedSchema(database, currentVersion);
      return;
    }

    if (currentVersion === 0) {
      database.exec(foundationMigration);
      currentVersion = 1;
    }
    if (currentVersion === 1) {
      const unexpectedProjects = database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM projects")
        .get()?.count;
      if (unexpectedProjects !== 0) throw new Error("PROJECT_BASE_BRANCH_REQUIRED");
      database.exec(projectsMigration);
    }
    const appliedVersions = readMigrationHistory(database);
    validateMigrationHistory(appliedVersions);
    validateClaimedSchema(database, LATEST_SCHEMA_VERSION);
  });
}
