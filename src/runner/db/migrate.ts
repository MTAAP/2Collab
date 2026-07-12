import type { Database } from "bun:sqlite";
import foundationMigration from "./migrations/0001_profiles_processes.sql" with { type: "text" };
import failedStartsMigration from "./migrations/0002_failed_starts.sql" with { type: "text" };
import startFenceMigration from "./migrations/0003_start_fence.sql" with { type: "text" };
import semanticOutboxMigration from "./migrations/0004_semantic_outbox.sql" with { type: "text" };
import runWorktreesMigration from "./migrations/0005_run_worktrees.sql" with { type: "text" };
import continuityCacheMigration from "./migrations/0006_continuity_cache.sql" with { type: "text" };

function verify(database: Database): void {
  const history = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  if (
    history.length !== 6 ||
    history[0]?.version !== 1 ||
    history[1]?.version !== 2 ||
    history[2]?.version !== 3 ||
    history[3]?.version !== 4 ||
    history[4]?.version !== 5 ||
    history[5]?.version !== 6
  ) {
    throw new Error("RUNNER_STATE_CORRUPT");
  }
  const tables = new Map(
    database
      .query<{ name: string; strict: number }, []>("PRAGMA table_list")
      .all()
      .map((row) => [row.name, row.strict]),
  );
  if (
    tables.get("schema_migrations") !== 1 ||
    tables.get("local_profile_versions") !== 1 ||
    tables.get("local_processes") !== 1 ||
    tables.get("local_diagnostic_tails") !== 1 ||
    tables.get("local_semantic_outbox") !== 1 ||
    tables.get("local_run_worktrees") !== 1 ||
    tables.get("local_continuity_cache") !== 1
  ) {
    throw new Error("RUNNER_STATE_CORRUPT");
  }
  const triggers = new Set(
    database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map((row) => row.name),
  );
  if (
    !triggers.has("local_profile_versions_immutable_update") ||
    !triggers.has("local_profile_versions_immutable_delete") ||
    !triggers.has("local_semantic_outbox_identity_immutable")
  ) {
    throw new Error("RUNNER_STATE_CORRUPT");
  }
  const processSql = database
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_processes'",
    )
    .get()?.sql;
  const profileSql = database
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_profile_versions'",
    )
    .get()?.sql;
  const diagnosticSql = database
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_diagnostic_tails'",
    )
    .get()?.sql;
  const worktreeSql = database
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_run_worktrees'",
    )
    .get()?.sql;
  const outboxSql = database
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_semantic_outbox'",
    )
    .get()?.sql;
  const cacheSql = database
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_continuity_cache'",
    )
    .get()?.sql;
  if (
    !processSql?.includes(
      "state IN ('RESERVED', 'STARTING', 'STARTED', 'FAILED_TO_START', 'EXITED', 'UNKNOWN')",
    ) ||
    !processSql.includes("assignment_digest") ||
    !profileSql?.includes("json_valid(definition_json)") ||
    !profileSql.includes("UNIQUE (profile_id, version)") ||
    !diagnosticSql?.includes("byte_count BETWEEN 0 AND 2097152") ||
    !diagnosticSql.includes("expires_at = created_at + 86400") ||
    !worktreeSql?.includes("'CREATING', 'READY', 'RETAINED', 'REMOVED', 'DISCARDED'") ||
    !worktreeSql.includes("summary_json") ||
    !outboxSql?.includes("'PENDING', 'IN_FLIGHT', 'ACKNOWLEDGED', 'PERMANENTLY_REJECTED'") ||
    !outboxSql.includes("local_sequence") ||
    !cacheSql?.includes("'SOURCE_REVISION', 'CONTEXT_REFERENCE', 'POLICY_FACT'") ||
    !cacheSql.includes("expires_at <= observed_at + 604800")
  ) {
    throw new Error("RUNNER_STATE_CORRUPT");
  }
  const integrity = database.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
  const foreignKeys = database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all();
  if (integrity?.quick_check !== "ok" || foreignKeys.length !== 0) {
    throw new Error("RUNNER_STATE_CORRUPT");
  }
}

export function migrateRunnerDatabase(database: Database, fresh: boolean): void {
  database.exec("PRAGMA foreign_keys = ON");
  if (fresh) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(foundationMigration);
      database.exec(failedStartsMigration);
      database.exec(startFenceMigration);
      database.exec(semanticOutboxMigration);
      database.exec(runWorktreesMigration);
      database.exec(continuityCacheMigration);
      verify(database);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return;
  }
  const ledger = database
    .query<{ count: number }, []>(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get()?.count;
  if (ledger !== 1) throw new Error("RUNNER_STATE_CORRUPT");
  const history = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  if (
    history.length >= 1 &&
    history.length <= 5 &&
    history.every((entry, index) => entry.version === index + 1)
  ) {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (history.length === 1) database.exec(failedStartsMigration);
      if (history.length <= 2) database.exec(startFenceMigration);
      if (history.length <= 3) database.exec(semanticOutboxMigration);
      if (history.length <= 4) database.exec(runWorktreesMigration);
      database.exec(continuityCacheMigration);
      verify(database);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return;
  }
  verify(database);
}
