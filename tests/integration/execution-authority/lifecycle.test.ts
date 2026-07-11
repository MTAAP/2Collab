import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import {
  type AuthorityDependencies,
  createExecutionAuthority,
  type DispatchPermitClaims,
  type RefreshedAuthorityFacts,
} from "../../../src/server/modules/execution-authority/execution-authority.ts";
import { createOperationAuthorizationConsumer } from "../../../src/server/modules/execution-authority/fencing.ts";
import type { CollabCommand } from "../../../src/shared/contracts/commands.ts";

const BASE_COMMIT = "a".repeat(40);
const CONFIG_DIGEST = "b".repeat(64);
const PROFILE_FINGERPRINT = "c".repeat(64);
const SECURITY_DIGEST = "d".repeat(64);
const SESSION_PROOF = "owner-session-proof-with-at-least-thirty-two-bytes";

function seed(database: Database): void {
  database.exec(`
    INSERT INTO deployments(id, singleton, team_id, revision, created_at)
      VALUES ('deployment_1', 1, 'team_1', 1, 0);
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
      VALUES ('owner_1', 'Owner', 'OWNER', 'ACTIVE', 1, 1, 0);
    INSERT INTO projects(id, team_id, name, base_branch, revision, created_at)
      VALUES ('project_1', 'team_1', 'Project', 'main', 1, 0);
    INSERT INTO runners(
      id, owner_member_id, runner_epoch, policy_revision, dispatch_audience,
      maximum_concurrent_attempts, security_policy_version, security_digest, revision,
      created_at, last_heartbeat_at
    ) VALUES (
      'runner_1', 'owner_1', 1, 1, 'OWNER_ONLY', 1, 1, '${SECURITY_DIGEST}', 1, 0, 100
    );
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

function memberActor() {
  return {
    kind: "MEMBER" as const,
    memberId: "owner_1" as never,
    sessionId: "member_session_1" as never,
    sessionProof: SESSION_PROOF,
  };
}

function runnerActor() {
  return { kind: "RUNNER" as const, runnerId: "runner_1" as never, runnerEpoch: 1 };
}

function schedulerActor(workflowExecutionId = "workflow_1") {
  return {
    kind: "SCHEDULER" as const,
    originalDispatcherId: "owner_1" as never,
    workflowExecutionId: workflowExecutionId as never,
  };
}

function seedSecondaryRunner(database: Database): void {
  database.exec(`
    INSERT INTO runners(
      id, owner_member_id, runner_epoch, policy_revision, dispatch_audience,
      maximum_concurrent_attempts, security_policy_version, security_digest, revision,
      created_at, last_heartbeat_at
    ) VALUES (
      'runner_2', 'owner_1', 1, 1, 'OWNER_ONLY', 1, 1, '${SECURITY_DIGEST}', 1, 0, 100
    );
  `);
}

function deliveredPermit(f: ReturnType<typeof fixture>, index = 0): string {
  const permit = f.delivered[index]?.permit;
  if (!permit) throw new Error("Expected a delivered permit.");
  return permit;
}

function launch(mode: "INSPECT_ONLY" | "MUTATING" = "INSPECT_ONLY") {
  return {
    kind: "LAUNCH_RUN" as const,
    idempotencyKey: `launch_${mode}` as never,
    actor: memberActor(),
    projectId: "project_1" as never,
    coordination: { kind: "NEW" as const, title: `${mode} work`, sourceRefs: [] },
    goal: "Implement Task 10.",
    repository: {
      repositoryId: "repository_1" as never,
      mode,
      assurance: "ADVISORY" as const,
      base: { kind: "EXACT" as const, commitSha: BASE_COMMIT as never },
      intendedBranch: "collab/task-10",
    },
    execution: {
      runnerId: "runner_1" as never,
      expectedRunnerEpoch: 1,
      projectMappingRevision: 1,
      profileVersionId: "profile_1" as never,
      expectedProfileVersion: 1,
      host: "NATIVE" as const,
      interaction: "HEADLESS" as const,
    },
    effectiveConfiguration: {
      configurationId: "configuration_1",
      version: 1,
      digest: CONFIG_DIGEST as never,
    },
  };
}

function fixture() {
  const database = new Database(":memory:", { strict: true });
  migrate(database);
  seed(database);
  let now = 100;
  const ids = new Map<string, number>();
  const delivered: Array<{ outboxId: string; permit: string }> = [];
  const refreshed: CollabCommand[] = [];
  let previewRefreshes = 0;
  const factOverrides: Partial<RefreshedAuthorityFacts> = {};
  const codec = {
    async sign(claims: DispatchPermitClaims) {
      return `signed.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    },
    async verify(token: string) {
      if (!token.startsWith("signed.")) {
        return {
          ok: false as const,
          error: {
            code: "PERMIT_INVALID",
            message: "Dispatch permit is invalid.",
            retry: "NEVER" as const,
          },
        };
      }
      return {
        ok: true as const,
        value: JSON.parse(
          Buffer.from(token.slice(7), "base64url").toString("utf8"),
        ) as DispatchPermitClaims,
      };
    },
  };
  const dependencies: AuthorityDependencies = {
    database,
    clock: () => now,
    id(prefix) {
      const next = (ids.get(prefix) ?? 0) + 1;
      ids.set(prefix, next);
      return `${prefix}_${next}`;
    },
    authorityFacts: {
      async preview() {
        previewRefreshes += 1;
        return {
          ok: true as const,
          value: { refreshedAt: now, profileFingerprint: PROFILE_FINGERPRINT },
        };
      },
      async refresh(command) {
        refreshed.push(command);
        return {
          ok: true as const,
          value: {
            projectRevision: 1,
            runnerOwnerMemberId: "owner_1",
            runnerPolicyRevision: 1,
            profileVersion: 1,
            profileFingerprint: PROFILE_FINGERPRINT,
            authorizationSource: "OWNER" as const,
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
            currentHead: BASE_COMMIT,
            ...factOverrides,
          },
        };
      },
    },
    permitCodec: codec,
    runnerControl: {
      async dispatch(intent) {
        delivered.push({ outboxId: intent.outboxId, permit: intent.permit });
        return { ok: true as const, value: undefined };
      },
    },
  };
  const authority = createExecutionAuthority(dependencies);
  return {
    authority,
    database,
    delivered,
    refreshed,
    previewRefreshes: () => previewRefreshes,
    setNow(value: number) {
      now = value;
    },
    setFacts(overrides: Partial<RefreshedAuthorityFacts>) {
      Object.assign(factOverrides, overrides);
    },
    close() {
      database.close();
    },
  };
}

async function startSession(f: ReturnType<typeof fixture>, mode: "INSPECT_ONLY" | "MUTATING") {
  const launched = await f.authority.execute(launch(mode));
  if (!launched.ok) throw new Error(launched.error.code);
  const consumed = await f.authority.execute({
    kind: "CONSUME_PERMIT",
    idempotencyKey: `consume_${mode}` as never,
    actor: runnerActor(),
    permit: deliveredPermit(f, f.delivered.length - 1),
    runnerId: "runner_1" as never,
    runnerEpoch: 1,
    connectionId: `connection_${mode}` as never,
  });
  if (!consumed.ok) throw new Error(consumed.error.code);
  return { launched: launched.value, session: consumed.value.session };
}

describe("deep execution authority", () => {
  test("preview refreshes facts and writes no authority state", async () => {
    const f = fixture();
    try {
      const before = f.database
        .query<{ count: number }, []>(
          `SELECT count(*) AS count FROM audit_events
           UNION ALL SELECT count(*) FROM dispatch_permits
           UNION ALL SELECT count(*) FROM authority_sessions
           UNION ALL SELECT count(*) FROM runner_dispatch_outbox`,
        )
        .all()
        .map((row) => row.count);
      const preview = await f.authority.preview({
        actor: memberActor(),
        projectId: "project_1" as never,
        repository: launch().repository,
        execution: launch().execution,
      });
      expect(preview.eligibleTargets).toHaveLength(1);
      expect(f.previewRefreshes()).toBe(1);
      const after = f.database
        .query<{ count: number }, []>(
          `SELECT count(*) AS count FROM audit_events
           UNION ALL SELECT count(*) FROM dispatch_permits
           UNION ALL SELECT count(*) FROM authority_sessions
           UNION ALL SELECT count(*) FROM runner_dispatch_outbox`,
        )
        .all()
        .map((row) => row.count);
      expect(after).toEqual(before);
    } finally {
      f.close();
    }
  });

  test("preview rejects a stale exact profile version without writing", async () => {
    const f = fixture();
    try {
      const preview = await f.authority.preview({
        actor: memberActor(),
        projectId: "project_1" as never,
        repository: launch().repository,
        execution: { ...launch().execution, expectedProfileVersion: 2 },
      });
      expect(preview.eligibleTargets).toEqual([]);
      expect(f.previewRefreshes()).toBe(1);
      expect(
        f.database.query<{ count: number }, []>("SELECT count(*) AS count FROM audit_events").get()
          ?.count,
      ).toBe(0);
    } finally {
      f.close();
    }
  });

  test("launch refreshes authority facts, commits hash-only permit, then signs for delivery", async () => {
    const f = fixture();
    try {
      const result = await f.authority.execute(launch());
      expect(result.ok).toBeTrue();
      expect(f.refreshed).toHaveLength(1);
      expect(f.delivered).toHaveLength(1);
      const permit = f.database
        .query<{ claims_hash: string; state: string }, []>(
          "SELECT claims_hash, state FROM dispatch_permits",
        )
        .get();
      expect(permit).toMatchObject({ state: "ISSUED" });
      expect(permit?.claims_hash).toHaveLength(64);
      expect(JSON.stringify(permit)).not.toContain("signed.");
    } finally {
      f.close();
    }
  });

  test("permit replay and stale session fences fail before an operation", async () => {
    const f = fixture();
    try {
      await f.authority.execute(launch("MUTATING"));
      const consumed = await f.authority.execute({
        kind: "CONSUME_PERMIT",
        idempotencyKey: "consume_1" as never,
        actor: runnerActor(),
        permit: deliveredPermit(f),
        runnerId: "runner_1" as never,
        runnerEpoch: 1,
        connectionId: "connection_1" as never,
      });
      expect(consumed.ok).toBeTrue();
      if (!consumed.ok) throw new Error(consumed.error.code);
      expect(consumed.value.session.mutationLease?.fence).toBe(1);

      const replay = await f.authority.execute({
        kind: "CONSUME_PERMIT",
        idempotencyKey: "consume_2" as never,
        actor: runnerActor(),
        permit: deliveredPermit(f),
        runnerId: "runner_1" as never,
        runnerEpoch: 1,
        connectionId: "connection_1" as never,
      });
      expect(replay).toMatchObject({ ok: false, error: { code: "PERMIT_REPLAYED" } });

      const renewed = await f.authority.execute({
        kind: "RENEW_AUTHORITY_SESSION",
        idempotencyKey: "renew_1" as never,
        actor: runnerActor(),
        sessionId: consumed.value.session.id,
        sessionFence: 1,
        runnerEpoch: 1,
      });
      expect(renewed.ok).toBeTrue();
      const stale = await f.authority.execute({
        kind: "AUTHORIZE_OPERATION",
        idempotencyKey: "operation_1" as never,
        actor: runnerActor(),
        sessionId: consumed.value.session.id,
        sessionFence: 1,
        operation: { kind: "MUTATE_REPOSITORY", expectedHead: BASE_COMMIT as never },
      });
      expect(stale).toMatchObject({ ok: false, error: { code: "SESSION_FENCE_STALE" } });
    } finally {
      f.close();
    }
  });

  test("expired permits never create authority sessions", async () => {
    const f = fixture();
    try {
      await f.authority.execute(launch());
      f.setNow(131);
      const expired = await f.authority.execute({
        kind: "CONSUME_PERMIT",
        idempotencyKey: "consume_expired" as never,
        actor: runnerActor(),
        permit: deliveredPermit(f),
        runnerId: "runner_1" as never,
        runnerEpoch: 1,
        connectionId: "connection_1" as never,
      });
      expect(expired).toMatchObject({ ok: false, error: { code: "PERMIT_EXPIRED" } });
      expect(
        f.database
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM audit_events WHERE kind = 'AUTHORITY_SESSION_OPENED'",
          )
          .get()?.count,
      ).toBe(0);
    } finally {
      f.close();
    }
  });

  test("lost attempt waits and resume creates a new immutable attempt", async () => {
    const f = fixture();
    try {
      const launched = await f.authority.execute(launch());
      if (!launched.ok) throw new Error(launched.error.code);
      const attemptId = launched.value.attempt.id;
      const lost = await f.authority.execute({
        kind: "ACCEPT_ATTEMPT_EVENT",
        idempotencyKey: "lost_1" as never,
        actor: runnerActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 1,
        attemptId,
        expectedAttemptRevision: 1,
        event: { kind: "LOST", observedAt: 110 },
      });
      expect(lost).toMatchObject({
        ok: true,
        value: { run: { state: "WAITING" }, attempt: { state: "LOST" } },
      });
      const checkpointed = await f.authority.execute({
        kind: "RECORD_CHECKPOINT",
        idempotencyKey: "checkpoint_1" as never,
        actor: runnerActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 2,
        attemptId,
        reason: "RECOVERY",
        requestedAction: "RESUME",
        summary: "Resume after runner loss.",
        runnerId: "runner_1" as never,
        worktreeIdentity: "worktree_1",
        currentCommit: BASE_COMMIT as never,
        evidenceIds: [],
        sourceRevisions: {},
        resumeGuidance: "Resume the durable goal in the existing worktree.",
      });
      expect(checkpointed.ok).toBeTrue();
      const resumed = await f.authority.execute({
        kind: "AUTHORIZE_ATTEMPT",
        idempotencyKey: "resume_1" as never,
        actor: memberActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 3,
        cause: { kind: "RESUME", checkpointId: "checkpoint_1" as never },
        execution: launch().execution,
      });
      expect(resumed).toMatchObject({
        ok: true,
        value: {
          decision: {
            outcome: "AUTHORIZED",
            run: { state: "RUNNING" },
            attempt: { state: "PENDING" },
          },
        },
      });
      expect(
        f.database
          .query<{ state: string }, []>("SELECT state FROM execution_attempts ORDER BY ordinal")
          .all()
          .map((row) => row.state),
      ).toEqual(["LOST", "PENDING"]);
    } finally {
      f.close();
    }
  });

  test("cancellation derives the active attempt and revocation invalidates unused permits", async () => {
    const f = fixture();
    try {
      const launched = await f.authority.execute(launch());
      if (!launched.ok) throw new Error(launched.error.code);
      const cancelled = await f.authority.execute({
        kind: "CANCEL_RUN",
        idempotencyKey: "cancel_1" as never,
        actor: memberActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 1,
        reason: "MEMBER_REQUEST",
      } as never);
      expect(cancelled).toMatchObject({
        ok: true,
        value: {
          run: { state: "CANCELLED" },
          termination: {
            kind: "REQUEST_TERMINATION",
            request: { attemptId: launched.value.attempt.id },
          },
        },
      });
      expect(
        f.database.query<{ state: string }, []>("SELECT state FROM dispatch_permits").get(),
      ).toEqual({ state: "REVOKED" });
    } finally {
      f.close();
    }
  });

  test("inspect-only sessions never authorize mutations", async () => {
    const f = fixture();
    try {
      await f.authority.execute(launch());
      const consumed = await f.authority.execute({
        kind: "CONSUME_PERMIT",
        idempotencyKey: "consume_inspect" as never,
        actor: runnerActor(),
        permit: deliveredPermit(f),
        runnerId: "runner_1" as never,
        runnerEpoch: 1,
        connectionId: "connection_1" as never,
      });
      if (!consumed.ok) throw new Error(consumed.error.code);
      const denied = await f.authority.execute({
        kind: "AUTHORIZE_OPERATION",
        idempotencyKey: "inspect_mutation" as never,
        actor: runnerActor(),
        sessionId: consumed.value.session.id,
        sessionFence: consumed.value.session.fence,
        operation: {
          kind: "PUBLISH_GIT_REFERENCE",
          expectedHead: BASE_COMMIT as never,
          remoteRef: "refs/heads/main",
        },
      });
      expect(denied).toMatchObject({ ok: false, error: { code: "REPOSITORY_MODE_DENIED" } });
    } finally {
      f.close();
    }
  });

  test("renewal fences, release, and hidden operation consumption are single-use", async () => {
    const f = fixture();
    try {
      const started = await startSession(f, "MUTATING");
      const renewed = await f.authority.execute({
        kind: "RENEW_AUTHORITY_SESSION",
        idempotencyKey: "renew_once" as never,
        actor: runnerActor(),
        sessionId: started.session.id,
        sessionFence: 1,
        runnerEpoch: 1,
      });
      expect(renewed).toMatchObject({ ok: true, value: { session: { fence: 2 } } });
      const stale = await f.authority.execute({
        kind: "RENEW_AUTHORITY_SESSION",
        idempotencyKey: "renew_stale" as never,
        actor: runnerActor(),
        sessionId: started.session.id,
        sessionFence: 1,
        runnerEpoch: 1,
      });
      expect(stale).toMatchObject({ ok: false, error: { code: "SESSION_FENCE_STALE" } });
      const authorized = await f.authority.execute({
        kind: "AUTHORIZE_OPERATION",
        idempotencyKey: "authorize_repo" as never,
        actor: runnerActor(),
        sessionId: started.session.id,
        sessionFence: 2,
        operation: { kind: "MUTATE_REPOSITORY", expectedHead: BASE_COMMIT as never },
      });
      if (!authorized.ok) throw new Error(authorized.error.code);
      const consumer = createOperationAuthorizationConsumer(f.database, () => 100);
      const consumeInput = {
        authorizationId: authorized.value.authorizationId,
        operationDigest: authorized.value.operationDigest,
        sessionId: started.session.id,
        sessionFence: 2,
      };
      expect(consumer.consume(consumeInput)).toMatchObject({ ok: true });
      expect(consumer.consume(consumeInput)).toMatchObject({
        ok: false,
        error: { code: "OPERATION_AUTHORIZATION_REPLAYED" },
      });
      const released = await f.authority.execute({
        kind: "RELEASE_AUTHORITY_SESSION",
        idempotencyKey: "release_1" as never,
        actor: runnerActor(),
        sessionId: started.session.id,
        sessionFence: 2,
        reason: "CHECKPOINTED",
      });
      expect(released.ok).toBeTrue();
      const afterRelease = await f.authority.execute({
        kind: "RENEW_AUTHORITY_SESSION",
        idempotencyKey: "renew_released" as never,
        actor: runnerActor(),
        sessionId: started.session.id,
        sessionFence: 2,
        runnerEpoch: 1,
      });
      expect(afterRelease).toMatchObject({
        ok: false,
        error: { code: "AUTHORITY_SESSION_INACTIVE" },
      });
    } finally {
      f.close();
    }
  });

  test("operation authorization expiry fails closed before the action", async () => {
    const f = fixture();
    try {
      const started = await startSession(f, "MUTATING");
      const authorized = await f.authority.execute({
        kind: "AUTHORIZE_OPERATION",
        idempotencyKey: "authorize_expiring" as never,
        actor: runnerActor(),
        sessionId: started.session.id,
        sessionFence: 1,
        operation: {
          kind: "PUBLISH_GIT_REFERENCE",
          expectedHead: BASE_COMMIT as never,
          remoteRef: "refs/heads/task-10",
        },
      });
      if (!authorized.ok) throw new Error(authorized.error.code);
      f.setNow(111);
      const consumer = createOperationAuthorizationConsumer(f.database, () => 111);
      expect(
        consumer.consume({
          authorizationId: authorized.value.authorizationId,
          operationDigest: authorized.value.operationDigest,
          sessionId: started.session.id,
          sessionFence: 1,
        }),
      ).toMatchObject({ ok: false, error: { code: "OPERATION_AUTHORIZATION_EXPIRED" } });
    } finally {
      f.close();
    }
  });

  test("connector writes recheck epoch, scope, external facts, and mutation guard", async () => {
    const f = fixture();
    try {
      f.database.exec(`
        INSERT INTO connector_epochs(connector_id, epoch, review_state, revision)
          VALUES ('github_1', 1, 'READY', 1);
        INSERT INTO connector_scopes(id, project_id, connector_id, connector_epoch, revision, created_at)
          VALUES ('scope_1', 'project_1', 'github_1', 1, 1, 0);
        INSERT INTO connector_scope_operations(scope_id, operation)
          VALUES ('scope_1', 'EDIT_ISSUE'), ('scope_1', 'EDIT_DOCUMENT_AS_BOT');
      `);
      f.setFacts({
        connectorEpochs: { github_1: 1 },
        connectorScopes: { github_1: ["EDIT_ISSUE", "EDIT_DOCUMENT_AS_BOT"] },
      });
      const started = await startSession(f, "MUTATING");
      const github = await f.authority.execute({
        kind: "AUTHORIZE_OPERATION",
        idempotencyKey: "github_write" as never,
        actor: runnerActor(),
        sessionId: started.session.id,
        sessionFence: 1,
        operation: {
          kind: "MUTATE_GITHUB",
          projectId: "project_1" as never,
          connectorId: "github_1" as never,
          connectorEpoch: 1,
          resourceId: "issue_1",
          precondition: {
            kind: "EXACT_REVISION",
            sourceRevision: "42",
            comparableDigest: "e".repeat(64) as never,
          },
          actionDigest: "f".repeat(64) as never,
          mutation: "EDIT_ISSUE",
        },
      });
      expect(github.ok).toBeTrue();
      const outline = await f.authority.execute({
        kind: "AUTHORIZE_OPERATION",
        idempotencyKey: "outline_write" as never,
        actor: runnerActor(),
        sessionId: started.session.id,
        sessionFence: 1,
        operation: {
          kind: "MUTATE_OUTLINE",
          projectId: "project_1" as never,
          connectorId: "github_1" as never,
          connectorEpoch: 1,
          documentId: "document_1",
          precondition: {
            kind: "EXACT_REVISION",
            sourceRevision: "7",
            comparableDigest: "e".repeat(64) as never,
          },
          actionDigest: "a".repeat(64) as never,
          mutation: "EDIT_DOCUMENT_AS_BOT",
        },
      });
      expect(outline.ok).toBeTrue();
      f.database.exec(
        "UPDATE connector_epochs SET epoch = 2, revision = revision + 1 WHERE connector_id = 'github_1'",
      );
      const stale = await f.authority.execute({
        kind: "AUTHORIZE_OPERATION",
        idempotencyKey: "github_stale" as never,
        actor: runnerActor(),
        sessionId: started.session.id,
        sessionFence: 1,
        operation: {
          kind: "MUTATE_GITHUB",
          projectId: "project_1" as never,
          connectorId: "github_1" as never,
          connectorEpoch: 1,
          resourceId: "issue_2",
          precondition: { kind: "ABSENT" },
          actionDigest: "b".repeat(64) as never,
          mutation: "EDIT_ISSUE",
        },
      });
      expect(stale).toMatchObject({ ok: false, error: { code: "CONNECTOR_REVOKED" } });
    } finally {
      f.close();
    }
  });

  test("concurrent permit consumption creates exactly one session", async () => {
    const f = fixture();
    try {
      await f.authority.execute(launch());
      const command = (idempotencyKey: string) => ({
        kind: "CONSUME_PERMIT" as const,
        idempotencyKey: idempotencyKey as never,
        actor: runnerActor(),
        permit: deliveredPermit(f),
        runnerId: "runner_1" as never,
        runnerEpoch: 1,
        connectionId: "connection_concurrent" as never,
      });
      const results = await Promise.all([
        f.authority.execute(command("consume_a")),
        f.authority.execute(command("consume_b")),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)[0]).toMatchObject({
        ok: false,
        error: { code: "PERMIT_REPLAYED" },
      });
      expect(
        f.database
          .query<{ count: number }, []>("SELECT count(*) AS count FROM authority_sessions")
          .get()?.count,
      ).toBe(1);
    } finally {
      f.close();
    }
  });

  test("result-before-exit completes only after process evidence arrives", async () => {
    const f = fixture();
    try {
      const launched = await f.authority.execute(launch());
      if (!launched.ok) throw new Error(launched.error.code);
      const acknowledged = await f.authority.execute({
        kind: "ACCEPT_ATTEMPT_EVENT",
        idempotencyKey: "ack_result_first" as never,
        actor: runnerActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 1,
        attemptId: launched.value.attempt.id,
        expectedAttemptRevision: 1,
        event: { kind: "ACKNOWLEDGED", observedAt: 101 },
      });
      expect(acknowledged.ok).toBeTrue();
      const started = await f.authority.execute({
        kind: "ACCEPT_ATTEMPT_EVENT",
        idempotencyKey: "start_result_first" as never,
        actor: runnerActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 1,
        attemptId: launched.value.attempt.id,
        expectedAttemptRevision: 2,
        event: { kind: "PROCESS_STARTED", observedAt: 102 },
      });
      expect(started.ok).toBeTrue();
      const result = await f.authority.execute({
        kind: "RECORD_RUN_RESULT",
        idempotencyKey: "result_first" as never,
        actor: runnerActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 2,
        attemptId: launched.value.attempt.id,
        result: "NO_CHANGES",
        summary: "The goal required no changes.",
        evidenceIds: [],
      });
      expect(result).toMatchObject({ ok: true, value: { run: { state: "RUNNING" } } });
      const exited = await f.authority.execute({
        kind: "ACCEPT_ATTEMPT_EVENT",
        idempotencyKey: "exit_result_first" as never,
        actor: runnerActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 2,
        attemptId: launched.value.attempt.id,
        expectedAttemptRevision: 3,
        event: {
          kind: "PROCESS_EXITED",
          observedAt: 103,
          exitCode: 0,
          correlationId: "correlation_result_first",
        },
      });
      expect(exited).toMatchObject({ ok: true, value: { run: { state: "COMPLETED" } } });
    } finally {
      f.close();
    }
  });

  test("exit-before-result waits for the typed result then completes", async () => {
    const f = fixture();
    try {
      const launched = await f.authority.execute(launch());
      if (!launched.ok) throw new Error(launched.error.code);
      await f.authority.execute({
        kind: "ACCEPT_ATTEMPT_EVENT",
        idempotencyKey: "ack_exit_first" as never,
        actor: runnerActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 1,
        attemptId: launched.value.attempt.id,
        expectedAttemptRevision: 1,
        event: { kind: "ACKNOWLEDGED", observedAt: 101 },
      });
      await f.authority.execute({
        kind: "ACCEPT_ATTEMPT_EVENT",
        idempotencyKey: "start_exit_first" as never,
        actor: runnerActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 1,
        attemptId: launched.value.attempt.id,
        expectedAttemptRevision: 2,
        event: { kind: "PROCESS_STARTED", observedAt: 102 },
      });
      const exited = await f.authority.execute({
        kind: "ACCEPT_ATTEMPT_EVENT",
        idempotencyKey: "exit_first" as never,
        actor: runnerActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 2,
        attemptId: launched.value.attempt.id,
        expectedAttemptRevision: 3,
        event: { kind: "PROCESS_EXITED", observedAt: 103, exitCode: 0 },
      });
      expect(exited).toMatchObject({ ok: true, value: { run: { state: "WAITING" } } });
      const result = await f.authority.execute({
        kind: "RECORD_RUN_RESULT",
        idempotencyKey: "result_after_exit" as never,
        actor: runnerActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 3,
        attemptId: launched.value.attempt.id,
        result: "DELIVERED",
        summary: "The goal was delivered.",
        evidenceIds: [],
      });
      expect(result).toMatchObject({ ok: true, value: { run: { state: "COMPLETED" } } });
    } finally {
      f.close();
    }
  });

  test("lost final attempt exhausts the budget and fails the run", async () => {
    const f = fixture();
    try {
      f.setFacts({ maximumAttempts: 1 });
      const launched = await f.authority.execute(launch());
      if (!launched.ok) throw new Error(launched.error.code);
      const lost = await f.authority.execute({
        kind: "ACCEPT_ATTEMPT_EVENT",
        idempotencyKey: "lost_budget" as never,
        actor: runnerActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 1,
        attemptId: launched.value.attempt.id,
        expectedAttemptRevision: 1,
        event: { kind: "LOST", observedAt: 110 },
      });
      expect(lost).toMatchObject({ ok: true, value: { run: { state: "FAILED" } } });
    } finally {
      f.close();
    }
  });

  test("evidence is typed, paginated, replayed once, and rolls back injected storage failure", async () => {
    const f = fixture();
    try {
      const launched = await f.authority.execute(launch());
      if (!launched.ok) throw new Error(launched.error.code);
      const evidenceCommand = (key: string, name: string) => ({
        kind: "RECORD_EVIDENCE" as const,
        idempotencyKey: key as never,
        actor: runnerActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 1,
        attemptId: launched.value.attempt.id,
        evidence: {
          kind: "VERIFICATION" as const,
          name,
          outcome: "PASSED" as const,
          durationMs: 10,
          summary: `${name} passed.`,
        },
      });
      const first = await f.authority.execute(evidenceCommand("evidence_1", "lint"));
      const replay = await f.authority.execute(evidenceCommand("evidence_1", "lint"));
      const second = await f.authority.execute(evidenceCommand("evidence_2", "test"));
      expect(first).toEqual(replay);
      expect(second.ok).toBeTrue();
      const pageOne = await f.authority.query({
        kind: "INSPECT_EVIDENCE",
        actor: memberActor(),
        runId: launched.value.run.id,
        limit: 1,
      });
      if (!pageOne.ok) throw new Error(pageOne.error.code);
      expect(pageOne.value.evidence).toHaveLength(1);
      const pageTwo = await f.authority.query({
        kind: "INSPECT_EVIDENCE",
        actor: memberActor(),
        runId: launched.value.run.id,
        after: pageOne.value.next,
        limit: 10,
      });
      expect(pageTwo).toMatchObject({
        ok: true,
        value: { evidence: [{ evidence: { kind: "VERIFICATION" } }] },
      });
      f.database.exec(`
        CREATE TRIGGER fail_evidence_insert BEFORE INSERT ON run_evidence
        BEGIN SELECT RAISE(ABORT, 'INJECTED_EVIDENCE_FAILURE'); END;
      `);
      const before = f.database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM run_evidence")
        .get()?.count;
      const failed = await f.authority.execute(evidenceCommand("evidence_3", "build"));
      expect(failed).toMatchObject({ ok: false, error: { code: "AUTHORITY_STORAGE_FAILED" } });
      expect(
        f.database.query<{ count: number }, []>("SELECT count(*) AS count FROM run_evidence").get()
          ?.count,
      ).toBe(before);
    } finally {
      f.close();
    }
  });

  test("source-specific revocation rules deny self-member and cross-runner authority", async () => {
    const f = fixture();
    try {
      seedSecondaryRunner(f.database);
      const selfMember = await f.authority.execute({
        kind: "APPLY_REVOCATION",
        idempotencyKey: "revoke_self_member" as never,
        actor: memberActor(),
        source: { kind: "MEMBER", memberId: "owner_1" as never, authorityEpoch: 1 },
      });
      expect(selfMember).toMatchObject({
        ok: false,
        error: { code: "REVOCATION_ACTOR_DENIED" },
      });

      const crossRunner = await f.authority.execute({
        kind: "APPLY_REVOCATION",
        idempotencyKey: "revoke_cross_runner" as never,
        actor: { kind: "RUNNER", runnerId: "runner_2" as never, runnerEpoch: 1 },
        source: { kind: "RUNNER", runnerId: "runner_1" as never, runnerEpoch: 1 },
      });
      expect(crossRunner).toMatchObject({
        ok: false,
        error: { code: "ACTOR_NOT_AUTHORIZED" },
      });
      expect(
        f.database
          .query<{ count: number }, []>("SELECT count(*) AS count FROM authority_revocations")
          .get()?.count,
      ).toBe(0);
    } finally {
      f.close();
    }
  });

  test("runner and scheduler queries fail closed outside their exact run scope", async () => {
    const f = fixture();
    try {
      seedSecondaryRunner(f.database);
      const launched = await f.authority.execute(launch());
      if (!launched.ok) throw new Error(launched.error.code);

      const runnerQuery = await f.authority.query({
        kind: "INSPECT_RUN",
        actor: { kind: "RUNNER", runnerId: "runner_2" as never, runnerEpoch: 1 },
        runId: launched.value.run.id,
      });
      expect(runnerQuery).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

      const schedulerQuery = await f.authority.query({
        kind: "INSPECT_RUN",
        actor: schedulerActor("unrelated_workflow"),
        runId: launched.value.run.id,
      });
      expect(schedulerQuery).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    } finally {
      f.close();
    }
  });

  test("reconciliation cannot acknowledge another run's delivery intent", async () => {
    const f = fixture();
    try {
      const first = await f.authority.execute(launch());
      const second = await f.authority.execute({
        ...launch(),
        idempotencyKey: "launch_second_run" as never,
        coordination: { kind: "NEW", title: "Second run", sourceRefs: [] },
      });
      if (!first.ok || !second.ok) throw new Error("Expected both runs to launch.");
      const foreignDeliveryId = f.database
        .query<{ id: string }, [string]>(
          `SELECT id FROM runner_dispatch_outbox WHERE attempt_id = ?`,
        )
        .get(first.value.attempt.id)?.id;
      if (!foreignDeliveryId) throw new Error("Expected first delivery intent.");
      const statusBefore = f.database
        .query<{ status: string }, [string]>(
          "SELECT status FROM runner_dispatch_outbox WHERE id = ?",
        )
        .get(foreignDeliveryId);

      const reconciled = await f.authority.execute({
        kind: "RECONCILE_OBSERVATION",
        idempotencyKey: "reconcile_foreign_delivery" as never,
        actor: runnerActor(),
        runId: second.value.run.id,
        expectedRunRevision: 1,
        observation: {
          kind: "OUTBOX_DELIVERY",
          deliveryId: foreignDeliveryId,
          disposition: "DELIVERED",
          observedAt: 110,
        },
      });
      expect(reconciled).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      expect(
        f.database
          .query<{ status: string }, [string]>(
            "SELECT status FROM runner_dispatch_outbox WHERE id = ?",
          )
          .get(foreignDeliveryId),
      ).toEqual(statusBefore);
    } finally {
      f.close();
    }
  });

  test("concurrent mutating launches elect one guard holder and explicit override shares its lifetime", async () => {
    const f = fixture();
    try {
      const seedRun = await f.authority.execute(launch("INSPECT_ONLY"));
      if (!seedRun.ok) throw new Error(seedRun.error.code);
      const contender = (key: string) => ({
        ...launch("MUTATING"),
        idempotencyKey: key as never,
        coordination: {
          kind: "EXISTING" as const,
          coordinationRecordId: seedRun.value.record.id,
          expectedRevision: seedRun.value.record.revision,
        },
      });
      const contenders = await Promise.all([
        f.authority.execute(contender("mutating_contender_a")),
        f.authority.execute(contender("mutating_contender_b")),
      ]);
      const winner = contenders.find((result) => result.ok);
      const loser = contenders.find((result) => !result.ok);
      expect(winner?.ok).toBe(true);
      expect(loser).toMatchObject({
        ok: false,
        error: { code: "COORDINATION_REVISION_CONFLICT" },
      });
      if (!winner?.ok) throw new Error("Expected one mutation guard winner.");

      const guard = f.database
        .query<{ id: string; run_id: string; fence: number; revision: number }, []>(
          "SELECT id, run_id, fence, revision FROM work_item_mutation_guards",
        )
        .get();
      if (!guard) throw new Error("Expected held mutation guard.");
      expect(guard).toMatchObject({ run_id: winner.value.run.id, fence: 1, revision: 1 });

      const currentRecordRevision = f.database
        .query<{ revision: number }, [string]>(
          "SELECT revision FROM coordination_records WHERE id = ?",
        )
        .get(seedRun.value.record.id)?.revision;
      if (!currentRecordRevision) throw new Error("Expected current coordination revision.");
      const blocked = await f.authority.execute({
        ...contender("mutating_guard_blocked"),
        coordination: {
          kind: "EXISTING",
          coordinationRecordId: seedRun.value.record.id,
          expectedRevision: currentRecordRevision,
        },
      });
      expect(blocked).toMatchObject({
        ok: false,
        error: { code: "MUTATION_GUARD_HELD" },
      });

      const colliding = await f.authority.execute({
        ...contender("mutating_explicit_override"),
        coordination: {
          kind: "EXISTING",
          coordinationRecordId: seedRun.value.record.id,
          expectedRevision: currentRecordRevision,
        },
        mutationGuardOverride: {
          guardedRunId: winner.value.run.id,
          expectedGuardedRunRevision: winner.value.run.revision,
          expectedGuardFence: guard.fence,
          expectedGuardRevision: guard.revision,
          reason: "Owner approved coordinated parallel mutation.",
        },
      });
      if (!colliding.ok) throw new Error(colliding.error.code);
      expect(
        f.database
          .query<{ count: number }, []>("SELECT count(*) AS count FROM work_item_mutation_guards")
          .get()?.count,
      ).toBe(1);
      expect(
        f.database
          .query<{ colliding_run_id: string }, []>(
            "SELECT colliding_run_id FROM mutation_guard_overrides",
          )
          .get(),
      ).toEqual({ colliding_run_id: colliding.value.run.id });

      const cancelWinner = await f.authority.execute({
        kind: "CANCEL_RUN",
        idempotencyKey: "cancel_guard_winner" as never,
        actor: memberActor(),
        runId: winner.value.run.id,
        expectedRunRevision: winner.value.run.revision,
        reason: "MEMBER_REQUEST",
      });
      expect(cancelWinner.ok).toBe(true);
      expect(
        f.database
          .query<{ state: string }, []>("SELECT state FROM work_item_mutation_guards")
          .get(),
      ).toEqual({ state: "HELD" });

      const cancelColliding = await f.authority.execute({
        kind: "CANCEL_RUN",
        idempotencyKey: "cancel_guard_colliding" as never,
        actor: memberActor(),
        runId: colliding.value.run.id,
        expectedRunRevision: colliding.value.run.revision,
        reason: "MEMBER_REQUEST",
      });
      expect(cancelColliding.ok).toBe(true);
      expect(
        f.database
          .query<{ state: string }, []>("SELECT state FROM work_item_mutation_guards")
          .get(),
      ).toEqual({ state: "RELEASED" });
    } finally {
      f.close();
    }
  });
});
