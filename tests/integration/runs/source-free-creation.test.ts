import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import { createDurableRunnerDispatch } from "../../../src/server/adapters/wss/durable-dispatch.ts";
import { LiveOutputHub } from "../../../src/server/adapters/wss/live-output.ts";
import { computeContextRecipeDigest } from "../../../src/server/modules/context/context-recipes.ts";
import { canonicalSourceReferenceKey } from "../../../src/server/modules/coordination-records/canonical-key.ts";
import {
  createLaunchPersistence,
  type LaunchPersistenceInput,
} from "../../../src/server/modules/execution-authority/persistence.ts";
import {
  prepareRunConfigurationSnapshot,
  resolveEffectiveRunConfiguration,
} from "../../../src/server/modules/presets/configuration-resolver.ts";
import type { ProjectId } from "../../../src/shared/contracts/ids.ts";
import {
  AttemptViewSchema,
  AuthoritySessionViewSchema,
  CoordinationRecordViewSchema,
  RunViewSchema,
} from "../../../src/shared/contracts/runs.ts";

const SESSION_PROOF = "owner-session-proof-with-at-least-thirty-two-bytes";
const PROFILE_FINGERPRINT = "c".repeat(64);
const SECURITY_DIGEST = "d".repeat(64);
const BASE_COMMIT = "a".repeat(40);
const RECIPE = {
  id: "recipe_1",
  version: 1,
  projectId: "project_1",
  perCategoryLimits: { SOURCE: 1 },
  maximumReferences: 1,
  maximumPreviewBytes: 0,
  freshnessSeconds: 30,
  predecessorPolicy: "NONE" as const,
};
const RECIPE_DIGEST = computeContextRecipeDigest(RECIPE);
const RESOLVED_CONFIGURATION = resolveEffectiveRunConfiguration(
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
    repositoryMode: "INSPECT_ONLY",
    repositoryAssurance: "ADVISORY",
    executionPolicy: "ONCE",
    maximumAttempts: 3,
    deadlineSeconds: 900,
    derivedTemplate: { id: "template_1", version: 1 },
    contextRecipeId: "recipe_1",
    contextRecipeVersion: 1,
    requiredGates: [],
    personalAddendum: "Personal addendum.",
  },
  {
    runGoal: "Implement the bounded Foundation slice.",
    authoredRunInput: "This run input.",
    teamTemplate: {
      id: "template_1",
      version: 1,
      coreInstructions: "Team core instructions.",
      typedVariables: { reviewDepth: "DEEP", stopOnConflict: true },
    },
    authorityFacts: {
      projectRevision: 1,
      runnerPolicyRevision: 1,
      securityPolicyVersion: 1,
      securityDigest: SECURITY_DIGEST as never,
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
if (!RESOLVED_CONFIGURATION.ok) throw new Error(RESOLVED_CONFIGURATION.error.code);
const PREPARED_CONFIGURATION = prepareRunConfigurationSnapshot({
  configuration: RESOLVED_CONFIGURATION.value,
  authoredRunInput: "This run input.",
  envelope: {
    schemaVersion: 1,
    contextRecipe: { id: "recipe_1", version: 1, digest: RECIPE_DIGEST },
    references: [
      {
        category: "SOURCE",
        referenceId: "issue_1",
        observedRevision: "revision_1",
        status: "FRESH",
      },
    ],
    omissions: [],
  },
});
if (!PREPARED_CONFIGURATION.ok) throw new Error(PREPARED_CONFIGURATION.error.code);
const PREPARED_CONFIGURATION_VALUE = PREPARED_CONFIGURATION.value;
const CONFIG_DIGEST = RESOLVED_CONFIGURATION.value.digest;

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
    INSERT INTO personal_run_presets(
      id, owner_member_id, project_id, display_name, state, current_version,
      revision, created_at, updated_at
    ) VALUES ('configuration_1', 'owner_1', 'project_1', 'Foundation', 'ACTIVE', 1, 1, 0, 0);
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
      'configuration_1', 1, 'template_1', 1, 'runner_1', 1, 1, 'profile_1', 1,
      '${PROFILE_FINGERPRINT}', 'NATIVE', 'HEADLESS', 'INSPECT_ONLY', 'ADVISORY',
      'ONCE', 3, 900, NULL, NULL, NULL, NULL, NULL, NULL, 'recipe_1', 1,
      NULL, NULL, 'Personal addendum.', '${"e".repeat(64)}', 0
    );
    INSERT INTO context_recipes(
      id, project_id, display_name, current_version, state, revision, created_at, updated_at
    ) VALUES ('recipe_1', 'project_1', 'Foundation', 1, 'ACTIVE', 1, 0, 0);
    INSERT INTO context_recipe_versions(
      recipe_id, version, include_goal, include_coordination, include_sources,
      include_repository, include_predecessor_evidence, maximum_references,
      maximum_preview_bytes, freshness_seconds, predecessor_policy, recipe_digest, created_at
    ) VALUES ('recipe_1', 1, 1, 0, 0, 0, 0, 1, 0, 30, 'NONE', '${RECIPE_DIGEST}', 0);
    INSERT INTO context_recipe_category_limits(
      recipe_id, recipe_version, category, maximum_references
    ) VALUES ('recipe_1', 1, 'SOURCE', 1);
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
    preparedConfiguration: PREPARED_CONFIGURATION_VALUE,
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
    configurationSnapshots: count("run_configuration_snapshots"),
    bootstrapEnvelopes: count("context_bootstrap_envelopes"),
    envelopeReferences: count("context_envelope_references"),
    attempts: count("execution_attempts"),
    attemptCauses: count("execution_attempt_causes"),
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
        configurationSnapshots: 1,
        bootstrapEnvelopes: 1,
        envelopeReferences: 1,
        attempts: 1,
        attemptCauses: 1,
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
      "run_configuration_snapshots",
      "execution_attempts",
      "execution_attempt_causes",
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
          configurationSnapshots: 0,
          bootstrapEnvelopes: 0,
          envelopeReferences: 0,
          attempts: 0,
          attemptCauses: 0,
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

  test("durable launch delivery carries the exact immutable instruction layers and assembly digests", async () => {
    const f = fixture();
    try {
      const launched = await f.persistence.create(launchInput());
      if (!launched.ok) throw new Error(launched.error.code);
      const dispatch = createDurableRunnerDispatch({
        database: f.database,
        output: new LiveOutputHub(),
        permitCodec: {
          sign: async () => "p".repeat(64),
          verify: async () => ({
            ok: false as const,
            error: { code: "PERMIT_INVALID", message: "Invalid.", retry: "NEVER" as const },
          }),
        },
      });
      await dispatch.prime();
      const operation = dispatch.loadCommitted(launched.value.outboxIds)[0];
      expect(operation?.body).toMatchObject({
        kind: "LAUNCH_ATTEMPT",
        instructions: {
          schemaVersion: 1,
          configurationDigest: CONFIG_DIGEST,
          assemblyDigest: PREPARED_CONFIGURATION_VALUE.assemblyDigest,
          contextEnvelopeDigest: PREPARED_CONFIGURATION_VALUE.envelopeDigest,
          layers: RESOLVED_CONFIGURATION.value.layers,
        },
      });
      expect(JSON.stringify(operation?.body)).not.toMatch(
        /executable|environment|credential|sourceBody|absolutePath/i,
      );
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
