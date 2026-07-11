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
import {
  RUN_AUTHORITY_INDEXES,
  RUN_AUTHORITY_TABLES,
  RUN_AUTHORITY_TRIGGERS,
  verifyRunsAuthoritySchema,
} from "../../../src/server/db/migrations/0004_runs_authority.verify.ts";

function versionThreeDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(foundationMigration);
  database.exec(projectsMigration);
  database.exec(runnersMigration);
  return database;
}

describe("runs and authority migration", () => {
  test("keeps exact strict v4 verified after migrating through v9", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      migrate(database);
      migrate(database);
      verifyRunsAuthoritySchema(database);
      expect(
        database
          .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((version) => ({ version })));
      for (const table of RUN_AUTHORITY_TABLES) {
        expect(
          database.query<{ strict: number }, []>(`PRAGMA table_list('${table}')`).get()?.strict,
        ).toBe(1);
      }
    } finally {
      database.close();
    }
  });

  test("upgrades v3 without rewriting Project or runner facts", () => {
    const database = versionThreeDatabase();
    try {
      database.exec(`
        INSERT INTO deployments(id, singleton, team_id, revision, created_at)
          VALUES ('deployment_1', 1, 'team_1', 1, 0);
        INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
          VALUES ('owner_1', 'Owner', 'OWNER', 'ACTIVE', 1, 1, 0);
        INSERT INTO projects(id, team_id, name, base_branch, revision, created_at)
          VALUES ('project_1', 'team_1', 'Project', 'main', 1, 0);
        INSERT INTO runners(
          id, owner_member_id, runner_epoch, policy_revision, dispatch_audience,
          maximum_concurrent_attempts, security_policy_version, security_digest, revision, created_at
        ) VALUES ('runner_1', 'owner_1', 1, 1, 'OWNER_ONLY', 1, 1, '${"a".repeat(64)}', 1, 0);
      `);

      migrate(database);

      expect(
        database.query<{ revision: number }, []>("SELECT revision FROM projects").get(),
      ).toEqual({ revision: 1 });
      expect(
        database.query<{ runner_epoch: number }, []>("SELECT runner_epoch FROM runners").get(),
      ).toEqual({ runner_epoch: 1 });
      verifyRunsAuthoritySchema(database);
    } finally {
      database.close();
    }
  });

  test("rolls a failed v4 migration back to an intact v3", () => {
    const database = versionThreeDatabase();
    try {
      database.exec("CREATE TABLE coordination_records(id TEXT PRIMARY KEY) STRICT");

      expect(() => migrate(database)).toThrow();

      expect(
        database
          .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  test("fails closed when a claimed-v4 security index or immutable trigger is missing", () => {
    for (const statement of [
      `DROP INDEX ${RUN_AUTHORITY_INDEXES[0]}`,
      `DROP TRIGGER ${RUN_AUTHORITY_TRIGGERS[0]}`,
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

  test("fails closed when claimed-v4 constraint semantics drift", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      migrate(database);
      const tableSql = database
        .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'agent_runs'")
        .get()?.sql;
      const indexSql = database
        .query<{ sql: string }, string[]>(
          "SELECT sql FROM sqlite_master WHERE name = 'agent_runs_coordination_state'",
        )
        .get()?.sql;
      const triggerSql = database
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE name = 'agent_run_provenance_immutable'",
        )
        .get()?.sql;
      expect(tableSql).toContain("length(goal) BETWEEN 1 AND 16384");
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec("DROP TABLE agent_runs");
      database.exec(
        (tableSql ?? "").replace("length(goal) BETWEEN 1 AND 16384", "length(goal) > 0"),
      );
      database.exec(indexSql ?? "");
      database.exec(triggerSql ?? "");
      database.exec("PRAGMA foreign_keys = ON");

      expect(() => migrate(database)).toThrow("SCHEMA_INTEGRITY_INVALID");
    } finally {
      database.close();
    }
  });

  test("contains no local execution, clear capability, or open payload columns", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      migrate(database);
      const schema = database
        .query<{ sql: string }, string[]>(
          `SELECT sql FROM sqlite_master
           WHERE name IN (${RUN_AUTHORITY_TABLES.map(() => "?").join(",")})`,
        )
        .all(...RUN_AUTHORITY_TABLES)
        .map((row) => row.sql.toLowerCase())
        .join("\n");
      for (const prohibited of [
        "absolute_path",
        "command_json",
        "environment_json",
        "output",
        "transcript",
        "permit_cleartext",
        "capability_cleartext",
        "payload_json",
      ]) {
        expect(schema).not.toContain(prohibited);
      }
    } finally {
      database.close();
    }
  });
});
