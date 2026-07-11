import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../src/server/db/migrate.ts";
import { createProjectRegistry } from "../../src/server/modules/projects/project-registry.ts";
import foundationMigration from "../../src/server/db/migrations/0001_foundation.sql" with {
  type: "text",
};
import { verifyProjectsSchema } from "../../src/server/db/migrations/0002_projects.verify.ts";

function seedDeployment(database: Database): void {
  database.exec(`
    INSERT INTO deployments(id, singleton, team_id, revision, created_at)
      VALUES ('deployment_1', 1, 'team_1', 1, 0);
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
      VALUES
        ('owner_1', 'Ada', 'OWNER', 'ACTIVE', 1, 1, 0),
        ('member_1', 'Lin', 'MEMBER', 'ACTIVE', 1, 1, 0);
    INSERT INTO sessions(
      id, member_id, proof_hash, kind, expires_at, idle_expires_at, absolute_expires_at,
      csrf_hash, member_authority_epoch, revision, created_at
    ) VALUES
      ('session_owner', 'owner_1', X'${new Bun.CryptoHasher("sha256").update("owner-proof-with-at-least-thirty-two-bytes").digest("hex")}', 'BROWSER', 10000, 10000, 10000, zeroblob(32), 1, 1, 0),
      ('session_member', 'member_1', X'${new Bun.CryptoHasher("sha256").update("member-proof-with-at-least-thirty-two-bytes").digest("hex")}', 'BROWSER', 10000, 10000, 10000, zeroblob(32), 1, 1, 0);
  `);
}

const owner = {
  kind: "MEMBER" as const,
  memberId: "owner_1" as never,
  sessionId: "session_owner" as never,
  sessionProof: "owner-proof-with-at-least-thirty-two-bytes",
};
const member = {
  kind: "MEMBER" as const,
  memberId: "member_1" as never,
  sessionId: "session_member" as never,
  sessionProof: "member-proof-with-at-least-thirty-two-bytes",
};

describe("server project registry", () => {
  test("creates projects only for an owner and derives id, team, and base branch authoritatively", async () => {
    const database = new Database(":memory:", { strict: true });
    try {
      migrate(database);
      seedDeployment(database);
      let sequence = 0;
      const registry = createProjectRegistry({
        database,
        clock: () => 100,
        id: () => `project_${++sequence}`,
      });

      const denied = await registry.create({ actor: member, name: "Denied", baseBranch: "main" });
      expect(denied.ok).toBeFalse();
      if (!denied.ok) expect(denied.error.code).toBe("OWNER_REQUIRED");

      const created = await registry.create({
        actor: owner,
        name: "Collab",
        baseBranch: "refs/heads/trunk",
      });
      expect(created).toEqual({
        ok: true,
        value: {
          id: "project_1",
          teamId: "team_1",
          name: "Collab",
          baseBranch: "refs/heads/trunk",
          revision: 1,
          createdAt: 100,
        },
      } as never);
      const listed = await registry.list({ actor: member });
      expect(listed.ok).toBeTrue();
      if (listed.ok) expect(listed.value.map((value) => value.id)).toEqual(["project_1"] as never);
    } finally {
      database.close();
    }
  });

  test("rejects caller-selected project identifiers, team routing, and invalid Git refs", async () => {
    const database = new Database(":memory:", { strict: true });
    try {
      migrate(database);
      seedDeployment(database);
      const registry = createProjectRegistry({ database, clock: () => 100, id: () => "project_1" });
      for (const command of [
        { actor: owner, name: "Project", baseBranch: "../main" },
        { actor: owner, name: "Project", baseBranch: "main", projectId: "chosen" },
        { actor: owner, name: "Project", baseBranch: "main", teamId: "team_other" },
      ]) {
        const result = await registry.create(command as never);
        expect(result.ok).toBeFalse();
        if (!result.ok) expect(result.error.code).toBe("PROJECT_INPUT_INVALID");
      }
    } finally {
      database.close();
    }
  });
});

describe("project migration", () => {
  test("upgrades an empty v1 database to strict v2 and is idempotent", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec(foundationMigration);
      migrate(database);
      migrate(database);
      verifyProjectsSchema(database);
      expect(
        database
          .query<{ name: string }, []>("PRAGMA table_info(projects)")
          .all()
          .map((row) => row.name),
      ).toContain("base_branch");
    } finally {
      database.close();
    }
  });

  test("rolls back a v1 upgrade rather than inventing a base branch", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      database.exec(foundationMigration);
      database.exec(
        "INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES ('deployment_1', 1, 'team_1', 1, 0)",
      );
      database.exec(
        "INSERT INTO projects(id, team_id, name, revision, created_at) VALUES ('project_legacy', 'team_1', 'Legacy', 1, 0)",
      );

      expect(() => migrate(database)).toThrow("PROJECT_BASE_BRANCH_REQUIRED");
      expect(
        database
          .query<{ name: string }, []>("PRAGMA table_info(projects)")
          .all()
          .map((row) => row.name),
      ).not.toContain("base_branch");
      expect(
        database.query<{ version: number }, []>("SELECT version FROM schema_migrations").all(),
      ).toEqual([{ version: 1 }]);
    } finally {
      database.close();
    }
  });

  test("enforces bounded identifiers, normalized names, Git refs, and dependent foreign keys", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      migrate(database);
      database.exec(
        "INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES ('deployment_1', 1, 'team_1', 1, 0)",
      );
      for (const statement of [
        "INSERT INTO projects(id, team_id, name, base_branch, revision, created_at) VALUES ('../project', 'team_1', 'Project', 'main', 1, 0)",
        "INSERT INTO projects(id, team_id, name, base_branch, revision, created_at) VALUES ('project_1', 'team_1', ' Project ', 'main', 1, 0)",
        "INSERT INTO projects(id, team_id, name, base_branch, revision, created_at) VALUES ('project_1', 'team_1', 'Project', '../main', 1, 0)",
      ]) {
        expect(() => database.exec(statement)).toThrow();
      }
      const insert = database.query<void, [string, string]>(
        "INSERT INTO projects(id, team_id, name, base_branch, revision, created_at) VALUES (?, 'team_1', 'Project', ?, 1, 0)",
      );
      for (const [index, invalidRef] of [
        "feature branch",
        "feature\nbranch",
        ".hidden",
        "feature/.hidden",
        "feature.lock",
        "feature.lock/child",
        "feature:child",
      ].entries()) {
        expect(() => insert.run(`invalid_${index}`, invalidRef)).toThrow();
      }
      expect(
        database
          .query<{ table: string }, []>("PRAGMA foreign_key_list(connector_scopes)")
          .all()
          .map((row) => row.table),
      ).toContain("projects");
    } finally {
      database.close();
    }
  });
});
