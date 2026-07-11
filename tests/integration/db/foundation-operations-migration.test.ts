import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import foundationMigration from "../../../src/server/db/migrations/0001_foundation.sql" with {
  type: "text",
};
import projectsMigration from "../../../src/server/db/migrations/0002_projects.sql" with {
  type: "text",
};
import runnersMigration from "../../../src/server/db/migrations/0003_runners.sql" with {
  type: "text",
};
import runsAuthorityMigration from "../../../src/server/db/migrations/0004_runs_authority.sql" with {
  type: "text",
};
import {
  FOUNDATION_OPERATION_INDEXES,
  FOUNDATION_OPERATION_TABLES,
  FOUNDATION_OPERATION_TRIGGERS,
  verifyFoundationOperationsSchema,
} from "../../../src/server/db/migrations/0005_foundation_operations.verify.ts";

function versionFourDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(foundationMigration);
  database.exec(projectsMigration);
  database.exec(runnersMigration);
  database.exec(runsAuthorityMigration);
  return database;
}

describe("foundation operations migration", () => {
  test("migrates empty storage through exact strict v5 and is idempotent", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      migrate(database);
      migrate(database);
      verifyFoundationOperationsSchema(database);
      expect(
        database
          .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([1, 2, 3, 4, 5, 6].map((version) => ({ version })));
      for (const table of FOUNDATION_OPERATION_TABLES) {
        expect(
          database.query<{ strict: number }, []>(`PRAGMA table_list('${table}')`).get()?.strict,
        ).toBe(1);
      }
    } finally {
      database.close();
    }
  });

  test("upgrades v4 without rewriting existing run authority facts", () => {
    const database = versionFourDatabase();
    try {
      database.exec(`
        INSERT INTO deployments(id, singleton, team_id, revision, created_at)
          VALUES ('deployment_1', 1, 'team_1', 1, 0);
        INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
          VALUES ('owner_1', 'Owner', 'OWNER', 'ACTIVE', 1, 1, 0);
        INSERT INTO projects(id, team_id, name, base_branch, revision, created_at)
          VALUES ('project_1', 'team_1', 'Project', 'main', 1, 0);
      `);
      migrate(database);
      expect(
        database.query<{ revision: number }, []>("SELECT revision FROM projects").get(),
      ).toEqual({
        revision: 1,
      });
      verifyFoundationOperationsSchema(database);
    } finally {
      database.close();
    }
  });

  test("rolls a failed v5 migration back to an intact v4", () => {
    const database = versionFourDatabase();
    try {
      database.exec("CREATE TABLE authority_sessions(id TEXT PRIMARY KEY) STRICT");
      expect(() => migrate(database)).toThrow();
      expect(
        database
          .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'run_checkpoints'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  test("fails closed when a claimed-v5 security object is missing", () => {
    for (const statement of [
      `DROP INDEX ${FOUNDATION_OPERATION_INDEXES[0]}`,
      `DROP TRIGGER ${FOUNDATION_OPERATION_TRIGGERS[0]}`,
      "DROP TRIGGER personal_run_preset_version_delete_denied",
      "DROP TRIGGER context_envelope_reference_delete_denied",
    ]) {
      const database = new Database(":memory:", { strict: true });
      try {
        migrate(database);
        database.exec(statement);
        expect(() => migrate(database)).toThrow("SCHEMA_INTEGRITY_INVALID");
      } finally {
        database.close();
      }
    }
  });

  test("fails closed when claimed-v5 constraint semantics drift", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      migrate(database);
      const tableSql = database
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE name = 'authority_sessions'",
        )
        .get()?.sql;
      const indexSql = database
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE name = 'active_authority_session_by_attempt'",
        )
        .get()?.sql;
      const triggerSql = database
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE name = 'authority_session_identity_immutable'",
        )
        .get()?.sql;
      expect(tableSql).toContain("fence > 0");
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec("DROP TABLE authority_sessions");
      database.exec((tableSql ?? "").replace("fence > 0", "fence >= 0"));
      database.exec(indexSql ?? "");
      database.exec(triggerSql ?? "");
      database.exec("PRAGMA foreign_keys = ON");
      expect(() => migrate(database)).toThrow("SCHEMA_INTEGRITY_INVALID");
    } finally {
      database.close();
    }
  });

  test("contains no clear capability, raw output, body, diff, command, environment, or path storage", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      migrate(database);
      const schema = database
        .query<{ sql: string }, string[]>(
          `SELECT sql FROM sqlite_master
           WHERE name IN (${FOUNDATION_OPERATION_TABLES.map(() => "?").join(",")})`,
        )
        .all(...FOUNDATION_OPERATION_TABLES)
        .map((row) => row.sql.toLowerCase())
        .join("\n");
      for (const prohibited of [
        "permit_cleartext",
        "capability_cleartext",
        "raw_output",
        "transcript",
        "source_body",
        "diff_body",
        "command_json",
        "environment_json",
        "absolute_path",
        "payload_json",
      ]) {
        expect(schema).not.toContain(prohibited);
      }
    } finally {
      database.close();
    }
  });
});
