import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import { computeContextRecipeDigest } from "../../../src/server/modules/context/context-recipes.ts";
import {
  type AuthorityDependencies,
  createExecutionAuthority,
  type DispatchPermitClaims,
  type RefreshedAuthorityFacts,
} from "../../../src/server/modules/execution-authority/execution-authority.ts";
import { createOperationAuthorizationConsumer } from "../../../src/server/modules/execution-authority/fencing.ts";
import {
  prepareRunConfigurationSnapshot,
  resolveEffectiveRunConfiguration,
} from "../../../src/server/modules/presets/configuration-resolver.ts";
import type { CollabCommand } from "../../../src/shared/contracts/commands.ts";

const BASE_COMMIT = "a".repeat(40);
const PROFILE_FINGERPRINT = "c".repeat(64);
const SECURITY_DIGEST = "d".repeat(64);
const SESSION_PROOF = "owner-session-proof-with-at-least-thirty-two-bytes";
const RECIPE = {
  id: "recipe_1",
  version: 1,
  projectId: "project_1",
  perCategoryLimits: {},
  maximumReferences: 1,
  maximumPreviewBytes: 0,
  freshnessSeconds: 30,
  predecessorPolicy: "NONE" as const,
};
const RECIPE_DIGEST = computeContextRecipeDigest(RECIPE);

function preparedConfiguration(
  mode: "INSPECT_ONLY" | "MUTATING",
  teamExposure = false,
  maximumAttempts = 3,
) {
  const resolved = resolveEffectiveRunConfiguration(
    {
      presetId: "configuration_1",
      presetVersion: 1,
      ownerMemberId: "owner_1",
      projectId: "project_1",
      runtime: "CODEX",
      runnerId: "runner_1",
      runnerEpoch: 1,
      mappingRevision: 1,
      profileId: "profile_1",
      profileVersion: 1,
      profileFingerprint: PROFILE_FINGERPRINT,
      host: "NATIVE",
      interaction: "HEADLESS",
      repositoryMode: "MUTATING",
      repositoryAssurance: "ADVISORY",
      executionPolicy: "ONCE",
      maximumAttempts: 3,
      deadlineSeconds: 900,
      contextRecipeId: "recipe_1",
      contextRecipeVersion: 1,
      requiredGates: [],
    },
    {
      repositoryMode: mode,
      maximumAttempts,
      runGoal: "Implement Task 10.",
      authorityFacts: {
        projectRevision: 1,
        runnerPolicyRevision: 1,
        securityPolicyVersion: 1,
        securityDigest: SECURITY_DIGEST as never,
        ...(teamExposure ? { exposureRevision: 1, acknowledgementVersion: 1 } : {}),
        connectorEpochs: {},
        grantIds: [],
      },
      currentBinding: {
        projectId: "project_1",
        runnerId: "runner_1",
        runnerEpoch: 1,
        mappingRevision: 1,
        profileId: "profile_1",
        profileVersion: 1,
        profileFingerprint: PROFILE_FINGERPRINT,
      },
    },
  );
  if (!resolved.ok) throw new Error(resolved.error.code);
  const prepared = prepareRunConfigurationSnapshot({
    configuration: resolved.value,
    envelope: {
      schemaVersion: 1,
      contextRecipe: { id: "recipe_1", version: 1, digest: RECIPE_DIGEST },
      references: [],
      omissions: [],
    },
  });
  if (!prepared.ok) throw new Error(prepared.error.code);
  return prepared.value;
}

const CONFIG_DIGEST = preparedConfiguration("INSPECT_ONLY").configuration.digest;

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
    INSERT INTO personal_run_presets(
      id, owner_member_id, project_id, display_name, state, current_version,
      revision, created_at, updated_at
    ) VALUES ('configuration_1', 'owner_1', 'project_1', 'Task 10', 'ACTIVE', 1, 1, 0, 0);
    INSERT INTO personal_run_preset_versions(
      preset_id, version, derived_template_id, derived_template_version,
      runner_id, runner_epoch, mapping_revision, profile_id, profile_version,
      profile_fingerprint, host, interaction, repository_mode, repository_assurance,
      execution_policy, maximum_attempts, deadline_seconds, managed_loop_max_iterations,
      managed_loop_cadence_seconds, stop_policy_digest, unknown_grace_seconds,
      unknown_backoff_initial_seconds, unknown_backoff_max_seconds, context_recipe_id,
      context_recipe_version, reusable_goal_template, reusable_instruction_template,
      personal_addendum, configuration_digest, created_at
    ) VALUES (
      'configuration_1', 1, NULL, NULL, 'runner_1', 1, 1, 'profile_1', 1,
      '${PROFILE_FINGERPRINT}', 'NATIVE', 'HEADLESS', 'MUTATING', 'ADVISORY',
      'ONCE', 3, 900, NULL, NULL, NULL, NULL, NULL, NULL, 'recipe_1', 1,
      NULL, NULL, NULL, '${"f".repeat(64)}', 0
    );
    INSERT INTO context_recipes(
      id, project_id, display_name, current_version, state, revision, created_at, updated_at
    ) VALUES ('recipe_1', 'project_1', 'Task 10', 1, 'ACTIVE', 1, 0, 0);
    INSERT INTO context_recipe_versions(
      recipe_id, version, include_goal, include_coordination, include_sources,
      include_repository, include_predecessor_evidence, maximum_references,
      maximum_preview_bytes, freshness_seconds, predecessor_policy, recipe_digest, created_at
    ) VALUES ('recipe_1', 1, 1, 0, 0, 0, 0, 1, 0, 30, 'NONE', '${RECIPE_DIGEST}', 0);
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

function seedTeamExposure(database: Database): void {
  database.exec(`
    UPDATE runners SET dispatch_audience = 'TEAM' WHERE id = 'runner_1';
    INSERT INTO runner_exposure_acknowledgements(
      id, version, runner_id, owner_member_id, project_id, mapping_revision,
      profile_id, profile_version, profile_fingerprint, policy_revision,
      security_policy_version, security_digest, acknowledgement_text,
      acknowledgement_digest, accepted_at
    ) VALUES (
      'ack_1', 1, 'runner_1', 'owner_1', 'project_1', 1,
      'profile_1', 1, '${PROFILE_FINGERPRINT}', 1, 1, '${SECURITY_DIGEST}',
      'I acknowledge this exact exposure.', '${"e".repeat(64)}', 0
    );
    INSERT INTO runner_exposures(
      id, runner_id, owner_member_id, project_id, mapping_revision, profile_id,
      profile_version, profile_fingerprint, policy_revision, security_policy_version,
      security_digest, acknowledgement_id, revision, created_at
    ) VALUES (
      'exposure_1', 'runner_1', 'owner_1', 'project_1', 1, 'profile_1',
      1, '${PROFILE_FINGERPRINT}', 1, 1, '${SECURITY_DIGEST}', 'ack_1', 1, 0
    );
  `);
}

function deliveredPermit(f: ReturnType<typeof fixture>, index = 0): string {
  const permit = f.delivered[index]?.permit;
  if (!permit) throw new Error("Expected a delivered permit.");
  return permit;
}

function launch(
  mode: "INSPECT_ONLY" | "MUTATING" = "INSPECT_ONLY",
  teamExposure = false,
  maximumAttempts = 3,
) {
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
      ...(teamExposure ? { exposureRevision: 1 } : {}),
    },
    effectiveConfiguration: {
      configurationId: "configuration_1",
      version: 1,
      digest: preparedConfiguration(mode, teamExposure, maximumAttempts).configuration.digest,
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
    runConfiguration: {
      async resolve(command, authority) {
        const prepared = preparedConfiguration(
          command.repository.mode,
          command.execution.exposureRevision !== undefined,
          authority.maximumAttempts,
        );
        return prepared.configuration.digest === command.effectiveConfiguration.digest
          ? { ok: true as const, value: prepared }
          : {
              ok: false as const,
              error: {
                code: "RUN_CONFIGURATION_STALE",
                message: "Run configuration changed.",
                retry: "REFRESH" as const,
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
      expect(
        f.database
          .query<{ cause_kind: string; checkpoint_id: string | null }, []>(
            `SELECT cause_kind, checkpoint_id FROM execution_attempt_causes
             ORDER BY created_at, attempt_id`,
          )
          .all(),
      ).toEqual([
        { cause_kind: "INITIAL", checkpoint_id: null },
        { cause_kind: "RESUME", checkpoint_id: "checkpoint_1" },
      ]);
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
      const launched = await f.authority.execute(launch("INSPECT_ONLY", false, 1));
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

  test("permit consumption rolls back when mutation authority disappears", async () => {
    const f = fixture();
    try {
      await f.authority.execute(launch("MUTATING"));
      f.database.exec("DELETE FROM work_item_mutation_guards");
      const consumed = await f.authority.execute({
        kind: "CONSUME_PERMIT",
        idempotencyKey: "consume_missing_guard" as never,
        actor: runnerActor(),
        permit: deliveredPermit(f),
        runnerId: "runner_1" as never,
        runnerEpoch: 1,
        connectionId: "connection_missing_guard" as never,
      });
      expect(consumed).toMatchObject({ ok: false, error: { code: "MUTATION_GUARD_LOST" } });
      expect(
        f.database
          .query<{ count: number }, []>("SELECT count(*) AS count FROM authority_sessions")
          .get()?.count,
      ).toBe(0);
    } finally {
      f.close();
    }
  });

  test("failed mutation lease renewal leaves the session fence unchanged", async () => {
    const f = fixture();
    try {
      const started = await startSession(f, "MUTATING");
      f.database
        .query("UPDATE mutation_leases SET expires_at = 101, disconnect_grace_expires_at = 101")
        .run();
      f.setNow(102);
      const renewed = await f.authority.execute({
        kind: "RENEW_AUTHORITY_SESSION",
        idempotencyKey: "renew_lost_lease" as never,
        actor: runnerActor(),
        sessionId: started.session.id,
        sessionFence: 1,
        runnerEpoch: 1,
      });
      expect(renewed).toMatchObject({ ok: false, error: { code: "MUTATION_LEASE_LOST" } });
      expect(
        f.database.query<{ fence: number }, []>("SELECT fence FROM authority_sessions").get()
          ?.fence,
      ).toBe(1);
    } finally {
      f.close();
    }
  });

  test("inspect-only sessions cannot authorize approval transitions", async () => {
    const f = fixture();
    try {
      const started = await startSession(f, "INSPECT_ONLY");
      f.setFacts({ approvalSubjects: { approval_1: CONFIG_DIGEST } });
      const result = await f.authority.execute({
        kind: "AUTHORIZE_OPERATION",
        idempotencyKey: "inspect_approval" as never,
        actor: runnerActor(),
        sessionId: started.session.id,
        sessionFence: 1,
        operation: {
          kind: "APPLY_APPROVAL_TRANSITION",
          approvalSubjectId: "approval_1" as never,
          expectedSubjectDigest: CONFIG_DIGEST as never,
        },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "REPOSITORY_MODE_DENIED" } });
    } finally {
      f.close();
    }
  });

  test("connector writes require a live mutation lease", async () => {
    const f = fixture();
    try {
      f.database.exec(`
        INSERT INTO connector_epochs(connector_id, epoch, review_state, revision)
          VALUES ('github_1', 1, 'READY', 1);
        INSERT INTO connector_scopes(id, project_id, connector_id, connector_epoch, revision, created_at)
          VALUES ('scope_1', 'project_1', 'github_1', 1, 1, 0);
        INSERT INTO connector_scope_operations(scope_id, operation) VALUES ('scope_1', 'EDIT_ISSUE');
      `);
      f.setFacts({
        connectorEpochs: { github_1: 1 },
        connectorScopes: { github_1: ["EDIT_ISSUE"] },
      });
      const started = await startSession(f, "MUTATING");
      f.database
        .query("UPDATE mutation_leases SET expires_at = 101, disconnect_grace_expires_at = 115")
        .run();
      f.setNow(102);
      const result = await f.authority.execute({
        kind: "AUTHORIZE_OPERATION",
        idempotencyKey: "connector_without_lease" as never,
        actor: runnerActor(),
        sessionId: started.session.id,
        sessionFence: 1,
        operation: {
          kind: "MUTATE_GITHUB",
          projectId: "project_1" as never,
          connectorId: "github_1" as never,
          connectorEpoch: 1,
          resourceId: "issue_1",
          precondition: { kind: "ABSENT" },
          actionDigest: "f".repeat(64) as never,
          mutation: "EDIT_ISSUE",
        },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "MUTATION_LEASE_LOST" } });
    } finally {
      f.close();
    }
  });

  test("runner reconciliation applies lost lifecycle and cannot regress an acknowledged outbox", async () => {
    const f = fixture();
    try {
      const launched = await f.authority.execute(launch());
      if (!launched.ok) throw new Error(launched.error.code);
      const lost = await f.authority.execute({
        kind: "RECONCILE_OBSERVATION",
        idempotencyKey: "reconcile_lost" as never,
        actor: runnerActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 1,
        observation: {
          kind: "RUNNER_ATTEMPT",
          attemptId: launched.value.attempt.id,
          observedState: "NOT_FOUND",
          observedAt: 101,
        },
      });
      expect(lost.ok).toBe(true);
      expect(
        f.database.query<{ state: string }, []>("SELECT state FROM execution_attempts").get()
          ?.state,
      ).toBe("LOST");
      expect(
        f.database.query<{ state: string }, []>("SELECT state FROM agent_runs").get()?.state,
      ).toBe("WAITING");

      const deliveryId = f.database
        .query<{ id: string }, []>("SELECT id FROM runner_dispatch_outbox")
        .get()?.id;
      if (!deliveryId) throw new Error("Expected delivery.");
      const delivered = await f.authority.execute({
        kind: "RECONCILE_OBSERVATION",
        idempotencyKey: "reconcile_delivered" as never,
        actor: runnerActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 2,
        observation: {
          kind: "OUTBOX_DELIVERY",
          deliveryId,
          disposition: "DELIVERED",
          observedAt: 102,
        },
      });
      expect(delivered.ok).toBe(true);
      const regressed = await f.authority.execute({
        kind: "RECONCILE_OBSERVATION",
        idempotencyKey: "reconcile_regression" as never,
        actor: runnerActor(),
        runId: launched.value.run.id,
        expectedRunRevision: 2,
        observation: {
          kind: "OUTBOX_DELIVERY",
          deliveryId,
          disposition: "RETRYABLE_FAILURE",
          observedAt: 103,
        },
      });
      expect(regressed).toMatchObject({ ok: false, error: { code: "OUTBOX_STATE_STALE" } });
    } finally {
      f.close();
    }
  });

  test("stale runner epochs cannot append checkpoints evidence or results", async () => {
    const f = fixture();
    try {
      const launched = await f.authority.execute(launch());
      if (!launched.ok) throw new Error(launched.error.code);
      f.database.query("UPDATE runners SET runner_epoch = 2 WHERE id = 'runner_1'").run();
      const staleActor = runnerActor();
      const evidence = await f.authority.execute({
        kind: "RECORD_EVIDENCE",
        idempotencyKey: "stale_evidence" as never,
        actor: staleActor,
        runId: launched.value.run.id,
        expectedRunRevision: 1,
        attemptId: launched.value.attempt.id,
        evidence: {
          kind: "VERIFICATION",
          name: "probe",
          outcome: "PASSED",
          durationMs: 1,
          summary: "probe",
        },
      });
      const result = await f.authority.execute({
        kind: "RECORD_RUN_RESULT",
        idempotencyKey: "stale_result" as never,
        actor: staleActor,
        runId: launched.value.run.id,
        expectedRunRevision: 1,
        attemptId: launched.value.attempt.id,
        result: "NO_CHANGES",
        summary: "No changes.",
        evidenceIds: [],
      });
      const checkpoint = await f.authority.execute({
        kind: "RECORD_CHECKPOINT",
        idempotencyKey: "stale_checkpoint" as never,
        actor: staleActor,
        runId: launched.value.run.id,
        expectedRunRevision: 1,
        attemptId: launched.value.attempt.id,
        reason: "RECOVERY",
        requestedAction: "RESUME",
        summary: "Recover.",
        runnerId: "runner_1" as never,
        worktreeIdentity: "worktree_1",
        evidenceIds: [],
        sourceRevisions: {},
        resumeGuidance: "Resume.",
      });
      for (const commandResult of [evidence, result, checkpoint]) {
        expect(commandResult).toMatchObject({ ok: false, error: { code: "RUNNER_EPOCH_CHANGED" } });
      }
    } finally {
      f.close();
    }
  });

  test("TEAM exposure requires a live exact acknowledgement at launch and permit consumption", async () => {
    const staleLaunch = fixture();
    try {
      seedTeamExposure(staleLaunch.database);
      staleLaunch.setFacts({ authorizationSource: "TEAM_EXPOSURE" });
      staleLaunch.database
        .query("UPDATE runner_exposure_acknowledgements SET revoked_at = 99 WHERE id = 'ack_1'")
        .run();
      const rejected = await staleLaunch.authority.execute({
        ...launch("INSPECT_ONLY", true),
        idempotencyKey: "stale_ack_launch" as never,
      });
      expect(rejected).toMatchObject({ ok: false, error: { code: "RUN_LAUNCH_FACTS_STALE" } });
    } finally {
      staleLaunch.close();
    }

    const stalePermit = fixture();
    try {
      seedTeamExposure(stalePermit.database);
      stalePermit.setFacts({ authorizationSource: "TEAM_EXPOSURE" });
      const launched = await stalePermit.authority.execute({
        ...launch("INSPECT_ONLY", true),
        idempotencyKey: "team_launch" as never,
      });
      expect(launched.ok).toBe(true);
      stalePermit.database
        .query("UPDATE runner_exposure_acknowledgements SET revoked_at = 101 WHERE id = 'ack_1'")
        .run();
      const consumed = await stalePermit.authority.execute({
        kind: "CONSUME_PERMIT",
        idempotencyKey: "team_consume" as never,
        actor: runnerActor(),
        permit: deliveredPermit(stalePermit),
        runnerId: "runner_1" as never,
        runnerEpoch: 1,
        connectionId: "team_connection" as never,
      });
      expect(consumed).toMatchObject({ ok: false, error: { code: "PERMIT_REVOKED" } });
    } finally {
      stalePermit.close();
    }
  });

  test("queries require the exact runner epoch and scheduler context", async () => {
    const f = fixture();
    try {
      const launched = await f.authority.execute({
        ...launch(),
        actor: schedulerActor("workflow_1"),
      });
      if (!launched.ok) throw new Error(launched.error.code);
      f.database.query("UPDATE runners SET runner_epoch = 2 WHERE id = 'runner_1'").run();
      const runnerQuery = await f.authority.query({
        kind: "INSPECT_RUN",
        actor: { kind: "RUNNER", runnerId: "runner_1" as never, runnerEpoch: 2 },
        runId: launched.value.run.id,
      });
      expect(runnerQuery).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      const schedulerQuery = await f.authority.query({
        kind: "INSPECT_RUN",
        actor: { kind: "SCHEDULER", originalDispatcherId: "owner_1" as never },
        runId: launched.value.run.id,
      });
      expect(schedulerQuery).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    } finally {
      f.close();
    }
  });

  test("checkpoint evidence must belong to the same run", async () => {
    const f = fixture();
    try {
      const first = await f.authority.execute(launch());
      const second = await f.authority.execute({
        ...launch(),
        idempotencyKey: "foreign_evidence_run" as never,
        coordination: { kind: "NEW", title: "Foreign evidence", sourceRefs: [] },
      });
      if (!first.ok || !second.ok) throw new Error("Expected launches.");
      const recorded = await f.authority.execute({
        kind: "RECORD_EVIDENCE",
        idempotencyKey: "foreign_evidence" as never,
        actor: runnerActor(),
        runId: second.value.run.id,
        expectedRunRevision: 1,
        attemptId: second.value.attempt.id,
        evidence: {
          kind: "VERIFICATION",
          name: "foreign",
          outcome: "PASSED",
          durationMs: 1,
          summary: "foreign",
        },
      });
      if (!recorded.ok) throw new Error(recorded.error.code);
      const checkpoint = await f.authority.execute({
        kind: "RECORD_CHECKPOINT",
        idempotencyKey: "cross_run_checkpoint" as never,
        actor: runnerActor(),
        runId: first.value.run.id,
        expectedRunRevision: 1,
        attemptId: first.value.attempt.id,
        reason: "RECOVERY",
        requestedAction: "RESUME",
        summary: "Recover.",
        runnerId: "runner_1" as never,
        worktreeIdentity: "worktree_1",
        evidenceIds: [recorded.value.evidence.id],
        sourceRevisions: {},
        resumeGuidance: "Resume.",
      });
      expect(checkpoint).toMatchObject({ ok: false, error: { code: "EVIDENCE_NOT_FOUND" } });
    } finally {
      f.close();
    }
  });
});
