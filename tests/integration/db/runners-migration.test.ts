import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../../src/server/db/migrate.ts";
import foundationMigration from "../../../src/server/db/migrations/0001_foundation.sql" with {
  type: "text",
};
import projectsMigration from "../../../src/server/db/migrations/0002_projects.sql" with {
  type: "text",
};
import { verifyRunnersSchema } from "../../../src/server/db/migrations/0003_runners.verify.ts";

function versionTwoDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec(foundationMigration);
  database.exec(projectsMigration);
  return database;
}

describe("runner migration", () => {
  test("keeps the v3 runner schema verified after later migrations", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      migrate(database);
      migrate(database);
      verifyRunnersSchema(database);
    } finally {
      database.close();
    }
  });

  test("upgrades v2 while preserving Projects", () => {
    const database = versionTwoDatabase();
    try {
      database.exec(`
        INSERT INTO deployments(id, singleton, team_id, revision, created_at)
          VALUES ('deployment_1', 1, 'team_1', 1, 0);
        INSERT INTO projects(id, team_id, name, base_branch, revision, created_at)
          VALUES ('project_1', 'team_1', 'Project', 'main', 1, 0);
      `);
      migrate(database);
      verifyRunnersSchema(database);
      expect(
        database.query<{ base_branch: string }, []>("SELECT base_branch FROM projects").get(),
      ).toEqual({
        base_branch: "main",
      });
    } finally {
      database.close();
    }
  });

  test("rolls a failed v3 migration back to valid v2", () => {
    const database = versionTwoDatabase();
    try {
      database.exec("CREATE TABLE runners(id TEXT PRIMARY KEY) STRICT");
      expect(() => migrate(database)).toThrow();
      expect(
        database
          .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([{ version: 1 }, { version: 2 }]);
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'runner_credentials'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  test("enforces immutable ownership and contains no local execution detail columns", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      migrate(database);
      database.exec(`
        INSERT INTO deployments(id, singleton, team_id, revision, created_at)
          VALUES ('deployment_1', 1, 'team_1', 1, 0);
        INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at) VALUES
          ('member_1', 'One', 'MEMBER', 'ACTIVE', 1, 1, 0),
          ('member_2', 'Two', 'MEMBER', 'ACTIVE', 1, 1, 0);
        INSERT INTO runners(
          id, owner_member_id, runner_epoch, policy_revision, dispatch_audience,
          maximum_concurrent_attempts, security_policy_version, security_digest,
          revision, created_at
        ) VALUES ('runner_1', 'member_1', 1, 1, 'OWNER_ONLY', 1, 1, '${"0".repeat(64)}', 1, 0);
      `);
      expect(() =>
        database.exec("UPDATE runners SET owner_member_id = 'member_2' WHERE id = 'runner_1'"),
      ).toThrow("RUNNER_OWNER_IMMUTABLE");
      const schema = database
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'runner%'",
        )
        .all()
        .map((row) => row.sql.toLowerCase())
        .join("\n");
      for (const prohibited of [
        "local_path",
        "command_json",
        "environment_json",
        "credential_cleartext",
      ])
        expect(schema).not.toContain(prohibited);
    } finally {
      database.close();
    }
  });
});
