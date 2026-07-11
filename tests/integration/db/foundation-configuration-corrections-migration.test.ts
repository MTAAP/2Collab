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
import foundationOperationsMigration from "../../../src/server/db/migrations/0005_foundation_operations.sql" with {
  type: "text",
};
import { verifyFoundationConfigurationCorrectionsSchema } from "../../../src/server/db/migrations/0006_foundation_configuration_corrections.verify.ts";

function versionFiveDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    foundationMigration,
    projectsMigration,
    runnersMigration,
    runsAuthorityMigration,
    foundationOperationsMigration,
  ]) {
    database.exec(migration);
  }
  return database;
}

function seedTwoRuns(database: Database): void {
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
    INSERT INTO runner_mapping_versions(runner_id, project_id, revision, local_mapping_id, created_at)
      VALUES ('runner_1', 'project_1', 1, 'mapping_1', 0);
    INSERT INTO safe_profile_versions(
      runner_id, profile_id, version, display_name, adapter, supports_native, supports_orca,
      supports_headless, supports_interactive, risk_summary, fingerprint, created_at
    ) VALUES ('runner_1', 'profile_1', 1, 'Profile', 'CODEX', 1, 0, 1, 0, 'Risk',
      '${"d".repeat(64)}', 0);
    INSERT INTO coordination_records(id, project_id, title, revision, created_at, updated_at)
      VALUES ('record_1', 'project_1', 'Record', 1, 0, 0);
    INSERT INTO agent_runs(
      id, coordination_record_id, project_id, state, goal, repository_id, repository_mode,
      repository_assurance, base_origin, base_commit, base_branch, worktree_identity,
      effective_configuration_id, effective_configuration_version, effective_configuration_digest,
      dispatcher_kind, dispatcher_id, revision, created_at
    ) VALUES
      ('run_1', 'record_1', 'project_1', 'QUEUED', 'One', 'repo_1', 'INSPECT_ONLY',
       'ADVISORY', 'EXACT', '${"b".repeat(40)}', 'main', 'worktree_1', 'preset_1', 1,
       '${"c".repeat(64)}', 'MEMBER', 'owner_1', 1, 0),
      ('run_2', 'record_1', 'project_1', 'QUEUED', 'Two', 'repo_1', 'INSPECT_ONLY',
       'ADVISORY', 'EXACT', '${"b".repeat(40)}', 'main', 'worktree_2', 'preset_1', 1,
       '${"c".repeat(64)}', 'MEMBER', 'owner_1', 1, 0);
    INSERT INTO execution_attempts(
      id, run_id, project_id, ordinal, runner_id, runner_epoch, mapping_revision,
      profile_version_id, profile_version, profile_fingerprint, host, interaction,
      state, revision, created_at, acknowledged_at, started_at, terminal_at, terminal_reason
    ) VALUES
      ('attempt_1', 'run_1', 'project_1', 1, 'runner_1', 1, 1, 'profile_1', 1,
       '${"d".repeat(64)}', 'NATIVE', 'HEADLESS', 'LOST', 1, 0, 0, 0, 1, 'LOST'),
      ('attempt_2', 'run_1', 'project_1', 2, 'runner_1', 1, 1, 'profile_1', 1,
       '${"d".repeat(64)}', 'NATIVE', 'HEADLESS', 'PENDING', 1, 2, NULL, NULL, NULL, NULL);
  `);
}

describe("foundation configuration corrections migration", () => {
  test("migrates through strict v6 and backfills typed attempt causes", () => {
    const database = versionFiveDatabase();
    try {
      seedTwoRuns(database);
      expect(
        database
          .query<{ runs: number; attempts: number }, []>(
            `SELECT (SELECT count(*) FROM agent_runs) AS runs,
                    (SELECT count(*) FROM execution_attempts) AS attempts`,
          )
          .get(),
      ).toEqual({ runs: 2, attempts: 2 });
      migrate(database);
      verifyFoundationConfigurationCorrectionsSchema(database);
      expect(
        database
          .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual(
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((version) => ({ version })),
      );
      expect(
        database
          .query<
            { attempt_id: string; cause_kind: string; predecessor_attempt_id: string | null },
            []
          >(
            `SELECT attempt_id, cause_kind, predecessor_attempt_id
             FROM execution_attempt_causes ORDER BY attempt_id`,
          )
          .all(),
      ).toEqual([
        { attempt_id: "attempt_1", cause_kind: "INITIAL", predecessor_attempt_id: null },
        { attempt_id: "attempt_2", cause_kind: "LEGACY_UNKNOWN", predecessor_attempt_id: null },
      ]);
    } finally {
      database.close();
    }
  });

  test("allows identical content-addressed envelopes for different runs", () => {
    const database = versionFiveDatabase();
    try {
      seedTwoRuns(database);
      migrate(database);
      const digest = "e".repeat(64);
      database.exec(`
        INSERT INTO context_bootstrap_envelopes(
          id, run_id, recipe_id, recipe_version, reference_count, preview_bytes,
          envelope_digest, created_at
        ) VALUES
          ('envelope_1', 'run_1', 'recipe_1', 1, 0, 0, '${digest}', 0),
          ('envelope_2', 'run_2', 'recipe_1', 1, 0, 0, '${digest}', 0);
      `);
      expect(
        database
          .query<{ count: number }, []>("SELECT count(*) AS count FROM context_bootstrap_envelopes")
          .get()?.count,
      ).toBe(2);
    } finally {
      database.close();
    }
  });

  test("fails closed when a claimed-v6 cause constraint drifts", () => {
    const database = new Database(":memory:", { strict: true });
    try {
      migrate(database);
      const sql = database
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE name = 'execution_attempt_causes'",
        )
        .get()?.sql;
      expect(sql).toContain("managed_loop_iteration > 0");
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec("DROP TABLE execution_attempt_causes");
      database.exec(
        (sql ?? "").replace("managed_loop_iteration > 0", "managed_loop_iteration >= 0"),
      );
      database.exec("PRAGMA foreign_keys = ON");
      expect(() => migrate(database)).toThrow("SCHEMA_INTEGRITY_INVALID");
    } finally {
      database.close();
    }
  });
});
