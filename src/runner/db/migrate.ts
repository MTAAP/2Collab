import type { Database } from "bun:sqlite";
import foundationMigration from "./migrations/0001_profiles_processes.sql" with { type: "text" };
import failedStartsMigration from "./migrations/0002_failed_starts.sql" with { type: "text" };
import startFenceMigration from "./migrations/0003_start_fence.sql" with { type: "text" };
import semanticOutboxMigration from "./migrations/0004_semantic_outbox.sql" with { type: "text" };

function verify(database: Database): void {
  const history = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  if (
    history.length !== 4 ||
    history[0]?.version !== 1 ||
    history[1]?.version !== 2 ||
    history[2]?.version !== 3 ||
    history[3]?.version !== 4
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
    tables.get("local_semantic_outbox") !== 1
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
    !triggers.has("local_profile_versions_immutable_delete")
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
  if (
    !processSql?.includes(
      "state IN ('RESERVED', 'STARTING', 'STARTED', 'FAILED_TO_START', 'EXITED', 'UNKNOWN')",
    ) ||
    !processSql.includes("assignment_digest") ||
    !profileSql?.includes("json_valid(definition_json)") ||
    !profileSql.includes("UNIQUE (profile_id, version)") ||
    !diagnosticSql?.includes("byte_count BETWEEN 0 AND 2097152") ||
    !diagnosticSql.includes("expires_at = created_at + 86400")
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
    history.length <= 3 &&
    history.every((entry, index) => entry.version === index + 1)
  ) {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (history.length === 1) database.exec(failedStartsMigration);
      if (history.length <= 2) database.exec(startFenceMigration);
      database.exec(semanticOutboxMigration);
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
