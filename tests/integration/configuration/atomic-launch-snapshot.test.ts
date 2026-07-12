import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import {
  type AuthorityDependencies,
  createExecutionAuthority,
} from "../../../src/server/modules/execution-authority/execution-authority.ts";

describe("atomic launch configuration snapshot", () => {
  test("fails before run, permit, outbox, audit, or dispatch when server-side resolution fails", async () => {
    const database = new Database(":memory:", { strict: true });
    migrate(database);
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
        '${"b".repeat(64)}', 0);
    `);
    let dispatched = 0;
    const dependencies: AuthorityDependencies = {
      database,
      clock: () => 100,
      id: (prefix) => `${prefix}_1`,
      authorityFacts: {
        async preview() {
          return {
            ok: true as const,
            value: { refreshedAt: 100, profileFingerprint: "b".repeat(64) },
          };
        },
        async refresh() {
          return {
            ok: true as const,
            value: {
              projectRevision: 1,
              runnerOwnerMemberId: "owner_1",
              runnerPolicyRevision: 1,
              profileVersion: 1,
              profileFingerprint: "b".repeat(64),
              authorizationSource: "OWNER" as const,
              securityPolicyVersion: 1,
              securityDigest: "a".repeat(64),
              resolvedBaseCommit: "c".repeat(40),
              baseBranch: "main",
              permitSeconds: 30,
              authoritySessionSeconds: 30,
              authorityRenewalSeconds: 10,
              mutationDisconnectGraceSeconds: 15,
              maximumAttempts: 1,
              deadlineAt: 1_000,
              connectorEpochs: {},
            },
          };
        },
      },
      runConfiguration: {
        async resolve() {
          return {
            ok: false as const,
            error: {
              code: "RUN_CONFIGURATION_STALE",
              message: "Run configuration changed.",
              retry: "REFRESH" as const,
            },
          };
        },
      },
      permitCodec: {
        async sign() {
          return "must-not-sign";
        },
        async verify() {
          return {
            ok: false as const,
            error: { code: "PERMIT_INVALID", message: "Invalid.", retry: "NEVER" as const },
          };
        },
      },
      runnerControl: {
        async dispatch() {
          dispatched += 1;
          return { ok: true as const, value: undefined };
        },
      },
    };
    const result = await createExecutionAuthority(dependencies).execute({
      kind: "LAUNCH_RUN",
      idempotencyKey: "launch_1" as never,
      actor: {
        kind: "MEMBER",
        memberId: "owner_1" as never,
        sessionId: "session_1" as never,
        sessionProof: "owner-session-proof-with-at-least-thirty-two-bytes",
      },
      projectId: "project_1" as never,
      coordination: { kind: "NEW", title: "Atomic launch", sourceRefs: [] },
      goal: "Resolve safe configuration first.",
      repository: {
        repositoryId: "repo_1" as never,
        mode: "INSPECT_ONLY",
        assurance: "ADVISORY",
        base: { kind: "EXACT", commitSha: "c".repeat(40) as never },
      },
      execution: {
        runnerId: "runner_1" as never,
        expectedRunnerEpoch: 1,
        projectMappingRevision: 1,
        profileVersionId: "profile_1" as never,
        expectedProfileVersion: 1,
        host: "NATIVE",
        interaction: "HEADLESS",
      },
      effectiveConfiguration: {
        configurationId: "preset_1",
        version: 1,
        digest: "d".repeat(64) as never,
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "RUN_CONFIGURATION_STALE" } });
    expect(dispatched).toBe(0);
    for (const table of [
      "coordination_records",
      "agent_runs",
      "run_configuration_snapshots",
      "context_bootstrap_envelopes",
      "dispatch_permits",
      "runner_dispatch_outbox",
      "audit_events",
    ]) {
      expect(
        database.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()
          ?.count,
      ).toBe(0);
    }
    database.close();
  });
});
