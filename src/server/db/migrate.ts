import type { Database } from "bun:sqlite";
import foundationMigration from "./migrations/0001_foundation.sql" with { type: "text" };
import projectsMigration from "./migrations/0002_projects.sql" with { type: "text" };
import { verifyProjectsTableSchema } from "./migrations/0002_projects.verify.ts";
import runnersMigration from "./migrations/0003_runners.sql" with { type: "text" };
import { verifyRunnersSchema } from "./migrations/0003_runners.verify.ts";
import runsAuthorityMigration from "./migrations/0004_runs_authority.sql" with { type: "text" };
import { verifyRunsAuthoritySchema } from "./migrations/0004_runs_authority.verify.ts";
import foundationOperationsMigration from "./migrations/0005_foundation_operations.sql" with {
  type: "text",
};
import { verifyFoundationOperationsSchema } from "./migrations/0005_foundation_operations.verify.ts";
import foundationConfigurationCorrectionsMigration from "./migrations/0006_foundation_configuration_corrections.sql" with {
  type: "text",
};
import { verifyFoundationConfigurationCorrectionsSchema } from "./migrations/0006_foundation_configuration_corrections.verify.ts";
import githubMigration from "./migrations/0007_github.sql" with { type: "text" };
import { verifyGitHubSchema } from "./migrations/0007_github.verify.ts";
import coordinationSourceMappingMigration from "./migrations/0008_coordination_source_mapping.sql" with {
  type: "text",
};
import { verifyCoordinationSourceMappingSchema } from "./migrations/0008_coordination_source_mapping.verify.ts";
import githubAttentionMigration from "./migrations/0009_github_attention.sql" with { type: "text" };
import { verifyGitHubAttentionSchema } from "./migrations/0009_github_attention.verify.ts";
import outlineMigration from "./migrations/0010_outline.sql" with { type: "text" };
import { verifyOutlineSchema } from "./migrations/0010_outline.verify.ts";
import outlineGrantsMigration from "./migrations/0011_outline_grants.sql" with { type: "text" };
import { verifyOutlineGrantSchema } from "./migrations/0011_outline_grants.verify.ts";
import outlineProposalsMigration from "./migrations/0012_outline_proposals.sql" with { type: "text" };
import { verifyOutlineProposalSchema } from "./migrations/0012_outline_proposals.verify.ts";
import { inImmediateTransaction } from "./transaction.ts";

export const LATEST_SCHEMA_VERSION = 12;
const MIGRATION_SOURCES = [
  foundationMigration,
  projectsMigration,
  runnersMigration,
  runsAuthorityMigration,
  foundationOperationsMigration,
  foundationConfigurationCorrectionsMigration,
  githubMigration,
  coordinationSourceMappingMigration,
  githubAttentionMigration,
  outlineMigration,
  outlineGrantsMigration,
  outlineProposalsMigration,
] as const;
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
    verifyProjectsTableSchema(database);
  }
  if (version >= 3) {
    verifyRunnersSchema(database);
  }
  if (version >= 4) {
    verifyRunsAuthoritySchema(database);
  }
  if (version >= 5) {
    verifyFoundationOperationsSchema(database);
  }
  if (version >= 6) {
    verifyFoundationConfigurationCorrectionsSchema(database);
  }
  if (version >= 7) {
    verifyGitHubSchema(database);
  }
  if (version >= 8) {
    verifyCoordinationSourceMappingSchema(database);
  }
  if (version >= 9) verifyGitHubAttentionSchema(database);
  if (version >= 10) verifyOutlineSchema(database);
  if (version >= 11) verifyOutlineGrantSchema(database);
  if (version >= 12) verifyOutlineProposalSchema(database);
  const integrity = database.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
  const foreignKeyFailures = database
    .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
    .all();
  if (integrity?.quick_check !== "ok" || foreignKeyFailures.length !== 0) {
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export type MigrationCatalog = Readonly<{
  currentVersion: number;
  digestForVersion(version: number): string | null;
  supportsRestoreFrom(version: number): boolean;
  migrateAndVerify(database: Database): void;
  verifyClaimedSchema(database: Database, version: number): void;
}>;

/**
 * The ordered migration bytes are executable schema truth. Their cumulative digest prevents a
 * backup that merely claims a familiar integer version from entering restore staging.
 */
export const migrationCatalog: MigrationCatalog = {
  currentVersion: LATEST_SCHEMA_VERSION,
  digestForVersion(version) {
    if (!Number.isInteger(version) || version < 1 || version > MIGRATION_SOURCES.length)
      return null;
    return sha256(
      MIGRATION_SOURCES.slice(0, version)
        .map((source, index) => `${index + 1}:${sha256(source)}`)
        .join("\n"),
    );
  },
  supportsRestoreFrom(version) {
    return Number.isInteger(version) && version >= 1 && version <= LATEST_SCHEMA_VERSION;
  },
  migrateAndVerify(database) {
    migrate(database);
  },
  verifyClaimedSchema(database, version) {
    const history = readMigrationHistory(database);
    validateMigrationHistory(history);
    if ((history.at(-1)?.version ?? 0) !== version) throw new Error("SCHEMA_VERSION_CLAIM_INVALID");
    validateClaimedSchema(database, version);
  },
};

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
      currentVersion = 2;
    }
    if (currentVersion === 2) {
      database.exec(runnersMigration);
      currentVersion = 3;
    }
    if (currentVersion === 3) {
      database.exec(runsAuthorityMigration);
      currentVersion = 4;
    }
    if (currentVersion === 4) {
      database.exec(foundationOperationsMigration);
      currentVersion = 5;
    }
    if (currentVersion === 5) {
      database.exec(foundationConfigurationCorrectionsMigration);
      currentVersion = 6;
    }
    if (currentVersion === 6) {
      database.exec(githubMigration);
      currentVersion = 7;
    }
    if (currentVersion === 7) {
      database.exec(coordinationSourceMappingMigration);
      currentVersion = 8;
    }
    if (currentVersion === 8) {
      database.exec(githubAttentionMigration);
      currentVersion = 9;
    }
    if (currentVersion === 9) {
      database.exec(outlineMigration);
      currentVersion = 10;
    }
    if (currentVersion === 10) {
      database.exec(outlineGrantsMigration);
      currentVersion = 11;
    }
    if (currentVersion === 11) {
      database.exec(outlineProposalsMigration);
    }
    const appliedVersions = readMigrationHistory(database);
    validateMigrationHistory(appliedVersions);
    validateClaimedSchema(database, LATEST_SCHEMA_VERSION);
  });
}
