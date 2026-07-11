import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import { canonicalSourceReferenceKey } from "../../../src/server/modules/coordination-records/canonical-key.ts";
import {
  createLaunchPersistence,
  type LaunchPersistenceInput,
} from "../../../src/server/modules/execution-authority/persistence.ts";
import type { ProjectId } from "../../../src/shared/contracts/ids.ts";
import {
  AttemptViewSchema,
  AuthoritySessionViewSchema,
  CoordinationRecordViewSchema,
  RunViewSchema,
} from "../../../src/shared/contracts/runs.ts";

const SESSION_PROOF = "owner-session-proof-with-at-least-thirty-two-bytes";
const CONFIG_DIGEST = "b".repeat(64);
const PROFILE_FINGERPRINT = "c".repeat(64);
const SECURITY_DIGEST = "d".repeat(64);
const BASE_COMMIT = "a".repeat(40);

function seedAuthorityFacts(database: Database): void {
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
    ) VALUES ('runner_1', 'owner_1', 1, 1, 'OWNER_ONLY', 1, 1, '${SECURITY_DIGEST}', 1, 0);
    INSERT INTO runner_mapping_versions(runner_id, project_id, revision, local_mapping_id, created_at)
      VALUES ('runner_1', 'project_1', 1, 'mapping_1', 0);
    INSERT INTO safe_profile_versions(
      runner_id, profile_id, version, display_name, adapter, supports_native, supports_orca,
      supports_headless, supports_interactive, risk_summary, fingerprint, created_at
    ) VALUES (
      'runner_1', 'profile_1', 1, 'Safe profile', 'CODEX', 1, 1, 1, 1,
      'Trusted local execution', '${PROFILE_FINGERPRINT}', 0
    );
  `);
}

function launchInput(overrides: Partial<LaunchPersistenceInput> = {}): LaunchPersistenceInput {
  return {
    command: {
      kind: "LAUNCH_RUN",
      idempotencyKey: "launch_1" as never,
      actor: {
        kind: "MEMBER",
        memberId: "owner_1" as never,
        sessionId: "session_1" as never,
        sessionProof: SESSION_PROOF,
      },
      projectId: "project_1" as ProjectId,
      coordination: { kind: "NEW", title: "Source-free work", sourceRefs: [] },
      goal: "Implement the bounded Foundation slice.",
      repository: {
        repositoryId: "repository_1" as never,
        mode: "INSPECT_ONLY",
        assurance: "ADVISORY",
        base: { kind: "EXACT", commitSha: BASE_COMMIT as never },
        intendedBranch: "collab/run-1",
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
        configurationId: "configuration_1",
        version: 1,
        digest: CONFIG_DIGEST as never,
      },
    },
    authority: {
      projectRevision: 1,
      runnerOwnerMemberId: "owner_1",
      runnerPolicyRevision: 1,
      profileVersion: 1,
      profileFingerprint: PROFILE_FINGERPRINT,
      authorizationSource: "OWNER",
      securityPolicyVersion: 1,
      securityDigest: SECURITY_DIGEST,
      resolvedBaseCommit: BASE_COMMIT,
      baseBranch: "main",
      permitSeconds: 30,
      authoritySessionSeconds: 30,
      authorityRenewalSeconds: 10,
      mutationDisconnectGraceSeconds: 15,
      maximumAttempts: 3,
      deadlineAt: 1_000,
      connectorEpochs: {},
    },
    ...overrides,
  } as LaunchPersistenceInput;
}

function fixture(failAfter?: string) {
  const database = new Database(":memory:", { strict: true });
  migrate(database);
  seedAuthorityFacts(database);
  const sequences = new Map<string, number>();
  const persistence = createLaunchPersistence({
    database,
    clock: () => 100,
    id(prefix) {
      const next = (sequences.get(prefix) ?? 0) + 1;
      sequences.set(prefix, next);
      return `${prefix}_${next}`;
    },
    afterWrite(table) {
      if (table === failAfter) throw new Error("INJECTED_COMMIT_FAILURE");
    },
  });
  const count = (table: string) =>
    database.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count ??
    -1;
  const counts = () => ({
    records: count("coordination_records"),
    runs: count("agent_runs"),
    attempts: count("execution_attempts"),
    snapshots: count("authority_snapshots"),
    permits: count("dispatch_permits"),
    audits: count("audit_events"),
    idempotency: count("idempotency_results"),
    outbox: count("runner_dispatch_outbox"),
  });
  return { database, persistence, counts };
}

describe("source-free launch persistence", () => {
  test("requires positive revisions on durable record, run, and attempt views", () => {
    expect(
      CoordinationRecordViewSchema.safeParse({
        id: "coordination_1",
        projectId: "project_1",
        title: "Record",
        revision: 0,
        runIds: [],
      }).success,
    ).toBeFalse();
    expect(
      RunViewSchema.safeParse({
        id: "run_1",
        coordinationRecordId: "coordination_1",
        state: "QUEUED",
        goal: "Goal",
        repositoryMode: "INSPECT_ONLY",
        repositoryAssurance: "ADVISORY",
        revision: 0,
        attemptIds: [],
      }).success,
    ).toBeFalse();
    expect(
      AttemptViewSchema.safeParse({
        id: "attempt_1",
        runId: "run_1",
        runnerId: "runner_1",
        state: "PENDING",
        revision: 0,
      }).success,
    ).toBeFalse();
    expect(
      AuthoritySessionViewSchema.safeParse({
        id: "session_1",
        attemptId: "attempt_1",
        fence: 0,
        issuedAt: 1,
        expiresAt: 2,
        repositoryAssurance: "ADVISORY",
        connectorEpochs: { github_1: 0 },
        repositoryMode: "INSPECT_ONLY",
      }).success,
    ).toBeFalse();
  });

  test("atomically creates the minimal launch graph and commits before delivery", async () => {
    const f = fixture();
    try {
      const created = await f.persistence.create(launchInput());

      expect(created.ok).toBeTrue();
      if (!created.ok) throw new Error(created.error.code);
      expect(created.value.outboxIds).toEqual(["outbox_1"]);
      expect(created.value.result).toEqual({
        kind: "LAUNCH_RUN",
        record: {
          id: "coordination_1",
          projectId: "project_1",
          title: "Source-free work",
          revision: 1,
          runIds: ["run_1"],
        },
        run: {
          id: "run_1",
          coordinationRecordId: "coordination_1",
          state: "QUEUED",
          goal: "Implement the bounded Foundation slice.",
          repositoryMode: "INSPECT_ONLY",
          repositoryAssurance: "ADVISORY",
          revision: 1,
          attemptIds: ["attempt_1"],
        },
        attempt: {
          id: "attempt_1",
          runId: "run_1",
          runnerId: "runner_1",
          state: "PENDING",
          revision: 1,
        },
        dispatch: {
          state: "QUEUED",
          runnerId: "runner_1",
          attemptId: "attempt_1",
          expiresAt: 130,
        },
      } as never);
      expect(f.counts()).toEqual({
        records: 1,
        runs: 1,
        attempts: 1,
        snapshots: 1,
        permits: 1,
        audits: 1,
        idempotency: 1,
        outbox: 1,
      });
      expect(
        f.database
          .query<{ status: string; dispatched_at: number | null }, []>(
            "SELECT status, dispatched_at FROM runner_dispatch_outbox",
          )
          .get(),
      ).toEqual({ status: "PENDING", dispatched_at: null });
    } finally {
      f.database.close();
    }
  });

  test("rolls every injected write failure back to zero launch effects", async () => {
    for (const boundary of [
      "coordination_records",
      "agent_runs",
      "execution_attempts",
      "authority_snapshots",
      "dispatch_permits",
      "audit_events",
      "idempotency_results",
      "runner_dispatch_outbox",
    ]) {
      const f = fixture(boundary);
      try {
        const failed = await f.persistence.create(launchInput());
        expect(failed.ok).toBeFalse();
        if (!failed.ok) expect(failed.error.code).toBe("RUN_LAUNCH_STORAGE_FAILED");
        expect(f.counts()).toEqual({
          records: 0,
          runs: 0,
          attempts: 0,
          snapshots: 0,
          permits: 0,
          audits: 0,
          idempotency: 0,
          outbox: 0,
        });
      } finally {
        f.database.close();
      }
    }
  });

  test("replays identical safe output and conflicts on changed input", async () => {
    const f = fixture();
    try {
      const first = await f.persistence.create(launchInput());
      const replay = await f.persistence.create(launchInput());
      const conflict = await f.persistence.create(
        launchInput({
          command: { ...launchInput().command, goal: "A different goal." },
        } as never),
      );

      expect(replay).toEqual(first);
      expect(conflict.ok).toBeFalse();
      if (!conflict.ok) expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(f.counts().runs).toBe(1);
      expect(f.counts().outbox).toBe(1);
    } finally {
      f.database.close();
    }
  });

  test("keeps snapshots and assignment provenance immutable and lifecycle transitions constrained", async () => {
    const f = fixture();
    try {
      expect((await f.persistence.create(launchInput())).ok).toBeTrue();
      expect(() => f.database.exec("UPDATE authority_snapshots SET runner_epoch = 2")).toThrow(
        "AUTHORITY_SNAPSHOT_IMMUTABLE",
      );
      expect(() => f.database.exec("UPDATE agent_runs SET repository_id = 'repository_2'")).toThrow(
        "RUN_PROVENANCE_IMMUTABLE",
      );
      expect(() => f.database.exec("UPDATE execution_attempts SET runner_id = 'runner_2'")).toThrow(
        "ATTEMPT_ASSIGNMENT_IMMUTABLE",
      );
      expect(() => f.database.exec("UPDATE execution_attempts SET state = 'RUNNING'")).toThrow();
      expect(() => f.database.exec("UPDATE agent_runs SET state = 'COMPLETED'")).toThrow();
      expect(() => f.database.exec("UPDATE agent_runs SET revision = 0")).toThrow();
    } finally {
      f.database.close();
    }
  });

  test("persists no actor proof, clear permit, output, command, environment, or path", async () => {
    const f = fixture();
    try {
      expect((await f.persistence.create(launchInput())).ok).toBeTrue();
      const rows = [
        "coordination_records",
        "agent_runs",
        "execution_attempts",
        "authority_snapshots",
        "dispatch_permits",
        "runner_dispatch_outbox",
        "audit_events",
        "idempotency_results",
      ].flatMap((table) => f.database.query(`SELECT * FROM ${table}`).all());
      const persisted = JSON.stringify(rows);
      expect(persisted).not.toContain(SESSION_PROOF);
      for (const canary of [
        "permit-clear-canary",
        "raw-output-canary",
        "command-canary",
        "environment-canary",
        "/absolute/worktree/canary",
      ]) {
        expect(persisted).not.toContain(canary);
      }
    } finally {
      f.database.close();
    }
  });

  test("maps one actionable source identity to one canonical record per Project", async () => {
    const f = fixture();
    try {
      const sourceRef = {
        kind: "GITHUB_ISSUE" as const,
        connectorId: "github_1" as never,
        sourceItemId: "issue_123",
        observedRevision: "revision_1",
      };
      const first = launchInput({
        command: {
          ...launchInput().command,
          coordination: { kind: "NEW", title: "Issue work", sourceRefs: [sourceRef] },
        },
      } as never);
      const second = launchInput({
        command: {
          ...launchInput().command,
          idempotencyKey: "launch_2" as never,
          coordination: { kind: "NEW", title: "Duplicate issue", sourceRefs: [sourceRef] },
        },
      } as never);

      expect(canonicalSourceReferenceKey("project_1", "github_1", "issue_123")).toBe(
        "9:project_1|8:github_1|9:issue_123",
      );
      expect((await f.persistence.create(first)).ok).toBeTrue();
      const conflict = await f.persistence.create(second);
      expect(conflict.ok).toBeFalse();
      if (!conflict.ok) expect(conflict.error.code).toBe("COORDINATION_SOURCE_CONFLICT");
      expect(f.counts().records).toBe(1);
      expect(f.counts().runs).toBe(1);
    } finally {
      f.database.close();
    }
  });

  test("reuses an existing Coordination Record only with exact revision CAS", async () => {
    const f = fixture();
    try {
      const first = await f.persistence.create(launchInput());
      if (!first.ok) throw new Error(first.error.code);
      const existing = {
        ...launchInput().command,
        idempotencyKey: "launch_2" as never,
        coordination: {
          kind: "EXISTING" as const,
          coordinationRecordId: first.value.result.record.id,
          expectedRevision: 1,
        },
      };
      const second = await f.persistence.create(launchInput({ command: existing } as never));
      expect(second.ok).toBeTrue();
      if (!second.ok) throw new Error(second.error.code);
      expect(second.value.result.record.revision).toBe(2);
      expect(second.value.result.record.runIds).toEqual(["run_1", "run_2"] as never);

      const stale = await f.persistence.create(
        launchInput({
          command: { ...existing, idempotencyKey: "launch_3" as never },
        } as never),
      );
      expect(stale.ok).toBeFalse();
      if (!stale.ok) expect(stale.error.code).toBe("COORDINATION_REVISION_CONFLICT");
      expect(f.counts().runs).toBe(2);
    } finally {
      f.database.close();
    }
  });
});
