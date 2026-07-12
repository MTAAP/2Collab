import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import {
  assembleBootstrapEnvelope,
  createContextRecipeStore,
} from "../../../src/server/modules/context/context-recipes.ts";
import {
  createConfigurationPersistence,
  resolveEffectiveRunConfiguration,
} from "../../../src/server/modules/presets/configuration-resolver.ts";
import { createPersonalRunPresetStore } from "../../../src/server/modules/presets/personal-run-presets.ts";
import { aggregateUsage, createUsageStore } from "../../../src/server/modules/telemetry/usage.ts";
import type { PersonalRunPresetVersion } from "../../../src/shared/contracts/presets.ts";

const PROFILE_FINGERPRINT = "c".repeat(64);
const SECURITY_DIGEST = "d".repeat(64);

function databaseFixture(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);
  database.exec(`
    INSERT INTO deployments(id, singleton, team_id, revision, created_at)
      VALUES ('deployment_1', 1, 'team_1', 1, 0);
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
      VALUES
        ('owner_1', 'Owner One', 'OWNER', 'ACTIVE', 1, 1, 0),
        ('member_2', 'Member Two', 'MEMBER', 'ACTIVE', 1, 1, 0),
        ('revoked_3', 'Revoked Three', 'MEMBER', 'REVOKED', 2, 2, 0);
    INSERT INTO projects(id, team_id, name, base_branch, revision, created_at)
      VALUES ('project_1', 'team_1', 'Project', 'main', 1, 0);
    INSERT INTO runners(
      id, owner_member_id, runner_epoch, policy_revision, dispatch_audience,
      maximum_concurrent_attempts, security_policy_version, security_digest, revision,
      created_at, last_heartbeat_at
    ) VALUES (
      'runner_1', 'owner_1', 2, 1, 'OWNER_ONLY', 2, 1, '${SECURITY_DIGEST}', 1, 0, 100
    );
    INSERT INTO runner_mapping_versions(runner_id, project_id, revision, local_mapping_id, created_at)
      VALUES ('runner_1', 'project_1', 1, 'mapping_1', 0);
    INSERT INTO safe_profile_versions(
      runner_id, profile_id, version, display_name, adapter, supports_native, supports_orca,
      supports_headless, supports_interactive, risk_summary, fingerprint, created_at
    ) VALUES (
      'runner_1', 'profile_1', 3, 'Safe profile', 'CODEX', 1, 1, 1, 1,
      'Trusted local execution', '${PROFILE_FINGERPRINT}', 0
    );
  `);
  return database;
}

function presetVersion(
  overrides: Partial<PersonalRunPresetVersion> = {},
): PersonalRunPresetVersion {
  return {
    presetId: "preset_1",
    presetVersion: 1,
    ownerMemberId: "owner_1",
    projectId: "project_1",
    runtime: "CODEX",
    runnerId: "runner_1",
    runnerEpoch: 2,
    mappingRevision: 1,
    profileId: "profile_1",
    profileVersion: 3,
    profileFingerprint: PROFILE_FINGERPRINT,
    host: "ORCA",
    interaction: "HEADLESS",
    repositoryMode: "MUTATING",
    repositoryAssurance: "ADVISORY",
    executionPolicy: "ONCE",
    maximumAttempts: 3,
    deadlineSeconds: 3_600,
    contextRecipeId: "recipe_1",
    contextRecipeVersion: 1,
    requiredGates: ["lint", "unit"],
    gateManifestFingerprint: "f".repeat(64) as never,
    personalAddendum: "Keep the implementation narrowly scoped.",
    ...overrides,
  };
}

function idFactory(): (prefix: string) => string {
  const sequences = new Map<string, number>();
  return (prefix) => {
    const value = (sequences.get(prefix) ?? 0) + 1;
    sequences.set(prefix, value);
    return `${prefix}_${value}`;
  };
}

describe("durable personal run preset versions", () => {
  test("enforces owner scope, expected revisions, immutable versions, archive, and exact defaults", async () => {
    const database = databaseFixture();
    database.exec(`
      INSERT INTO context_recipes(
        id, project_id, display_name, current_version, state, revision, created_at, updated_at
      ) VALUES ('recipe_1', 'project_1', 'Lean', 1, 'ACTIVE', 1, 0, 0);
      INSERT INTO context_recipe_versions(
        recipe_id, version, include_goal, include_coordination, include_sources,
        include_repository, include_predecessor_evidence, maximum_references,
        maximum_preview_bytes, freshness_seconds, predecessor_policy, recipe_digest, created_at
      ) VALUES ('recipe_1', 1, 1, 0, 1, 0, 0, 3, 16, 30, 'NONE', '${"a".repeat(64)}', 0);
      INSERT INTO context_recipe_category_limits(
        recipe_id, recipe_version, category, maximum_references
      ) VALUES ('recipe_1', 1, 'SOURCE', 2);
    `);
    const store = createPersonalRunPresetStore({ database, clock: () => 100, id: idFactory() });

    expect(
      await store.create({
        actorMemberId: "member_2",
        displayName: "Owner-only preset",
        version: presetVersion(),
      }),
    ).toMatchObject({ ok: false, error: { code: "PRESET_OWNER_REQUIRED" } });

    const created = await store.create({
      actorMemberId: "owner_1",
      displayName: "Implementation headless",
      version: presetVersion(),
    });
    expect(created).toMatchObject({
      ok: true,
      value: { id: "preset_1", currentVersion: 1, revision: 1, state: "ACTIVE" },
    });

    expect(
      await store.edit({
        actorMemberId: "owner_1",
        presetId: "preset_1",
        expectedRevision: 2,
        version: presetVersion({ presetVersion: 2, maximumAttempts: 1 }),
      }),
    ).toMatchObject({ ok: false, error: { code: "PRESET_REVISION_CONFLICT" } });

    const edited = await store.edit({
      actorMemberId: "owner_1",
      presetId: "preset_1",
      expectedRevision: 1,
      version: presetVersion({ presetVersion: 2, maximumAttempts: 1 }),
    });
    expect(edited).toMatchObject({ ok: true, value: { currentVersion: 2, revision: 2 } });
    expect(store.inspectVersion("owner_1", "preset_1", 1)).toMatchObject({
      ok: true,
      value: { presetVersion: 1, maximumAttempts: 3 },
    });
    expect(store.inspectVersion("member_2", "preset_1", 1)).toMatchObject({
      ok: false,
      error: { code: "PRESET_NOT_FOUND" },
    });

    expect(
      store.setProjectDefault({
        actorMemberId: "owner_1",
        projectId: "project_1",
        presetId: "preset_1",
        presetVersion: 2,
        expectedRevision: 0,
      }),
    ).toMatchObject({ ok: true, value: { presetVersion: 2, revision: 1 } });
    expect(store.projectDefault("owner_1", "project_1")).toMatchObject({
      ok: true,
      value: { presetId: "preset_1", presetVersion: 2, version: { maximumAttempts: 1 } },
    });

    expect(
      store.archive({ actorMemberId: "owner_1", presetId: "preset_1", expectedRevision: 2 }),
    ).toMatchObject({ ok: true, value: { state: "ARCHIVED", revision: 3 } });
    expect(
      store.setProjectDefault({
        actorMemberId: "owner_1",
        projectId: "project_1",
        presetId: "preset_1",
        presetVersion: 2,
        expectedRevision: 1,
      }),
    ).toMatchObject({ ok: false, error: { code: "PRESET_ARCHIVED" } });
    expect(store.projectDefault("owner_1", "project_1")).toMatchObject({
      ok: false,
      error: { code: "PRESET_DEFAULT_STALE" },
    });

    database.close();
  });

  test("rejects revoked members and stale or private runner bindings without leaking them", async () => {
    const database = databaseFixture();
    const store = createPersonalRunPresetStore({ database, clock: () => 100, id: idFactory() });

    expect(
      await store.create({
        actorMemberId: "revoked_3",
        displayName: "Rejected",
        version: presetVersion({ ownerMemberId: "revoked_3" }),
      }),
    ).toMatchObject({ ok: false, error: { code: "MEMBER_AUTHORITY_REQUIRED" } });
    expect(
      await store.create({
        actorMemberId: "owner_1",
        displayName: "Stale runner",
        version: presetVersion({ runnerEpoch: 1 }),
      }),
    ).toMatchObject({ ok: false, error: { code: "PRESET_BINDING_STALE" } });
    expect(
      await store.create({
        actorMemberId: "owner_1",
        displayName: "Global owner preset",
        version: presetVersion({
          presetId: "preset_global",
          projectId: undefined,
          contextRecipeId: undefined,
          contextRecipeVersion: undefined,
        }),
      }),
    ).toMatchObject({ ok: true, value: { id: "preset_global" } });
    expect(
      await store.create({
        actorMemberId: "owner_1",
        displayName: "Private payload",
        version: { ...presetVersion(), environment: { TOKEN: "secret" } } as never,
      }),
    ).toMatchObject({ ok: false, error: { code: "PRESET_PRIVATE_CONFIGURATION" } });
    expect(JSON.stringify(store.list("member_2"))).not.toContain("preset_1");

    database.close();
  });
});

describe("durable context and run configuration snapshots", () => {
  test("persists recipe budgets and bounded envelopes without granting authority", () => {
    const database = databaseFixture();
    const recipeStore = createContextRecipeStore({ database, clock: () => 100 });
    const created = recipeStore.create({
      actorMemberId: "owner_1",
      id: "recipe_1",
      projectId: "project_1",
      displayName: "Lean",
      version: {
        id: "recipe_1",
        version: 1,
        projectId: "project_1",
        digest: "a".repeat(64),
        perCategoryLimits: { SOURCE: 2, COORDINATION: 1 },
        maximumReferences: 3,
        maximumPreviewBytes: 5,
        freshnessSeconds: 30,
        predecessorPolicy: "LATEST_CHECKPOINT",
      },
    });
    expect(created).toMatchObject({ ok: true, value: { currentVersion: 1 } });
    expect(recipeStore.inspectVersion("project_1", "recipe_1", 1)).toMatchObject({
      ok: true,
      value: { perCategoryLimits: { COORDINATION: 1, SOURCE: 2 } },
    });
    expect(
      recipeStore.edit({
        actorMemberId: "owner_1",
        id: "recipe_1",
        expectedRevision: 1,
        version: {
          ...(created.ok ? created.value.version : ({} as never)),
          version: 2,
          maximumReferences: 1,
        },
      }),
    ).toMatchObject({ ok: true, value: { currentVersion: 2, revision: 2 } });
    expect(recipeStore.inspectVersion("project_1", "recipe_1", 1)).toMatchObject({
      ok: true,
      value: { maximumReferences: 3 },
    });
    expect(
      recipeStore.archive({
        actorMemberId: "owner_1",
        id: "recipe_1",
        projectId: "project_1",
        expectedRevision: 2,
      }),
    ).toMatchObject({ ok: true, value: { state: "ARCHIVED", revision: 3 } });

    const envelope = assembleBootstrapEnvelope(
      created.ok ? created.value.version : ({} as never),
      [
        {
          category: "SOURCE",
          referenceId: "issue_1",
          canonicalKey: "github:issue:1",
          observedRevision: "rev_1",
          observedAt: 90,
          availability: "AVAILABLE",
          authority: "AUTHORIZED",
          priority: 10,
          authoredPreview: "Aé€B",
        },
        {
          category: "SOURCE",
          referenceId: "issue_forbidden",
          canonicalKey: "github:issue:2",
          observedRevision: "rev_2",
          observedAt: 90,
          availability: "AVAILABLE",
          authority: "FORBIDDEN",
          priority: 20,
          authoredPreview: "must not persist",
        },
      ],
      100,
    );
    expect(envelope).toMatchObject({
      ok: true,
      value: {
        references: [{ referenceId: "issue_1", authoredPreview: "Aé" }],
        omissions: [{ referenceId: "issue_forbidden", reason: "FORBIDDEN" }],
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("must not persist");

    database.close();
  });

  test("preset edits cannot rewrite the effective configuration and envelope captured for a run", async () => {
    const database = databaseFixture();
    const ids = idFactory();
    const presetStore = createPersonalRunPresetStore({ database, clock: () => 100, id: ids });
    const recipeStore = createContextRecipeStore({ database, clock: () => 100 });
    const configurationStore = createConfigurationPersistence({
      database,
      clock: () => 100,
      id: ids,
    });
    const recipe = recipeStore.create({
      actorMemberId: "owner_1",
      id: "recipe_1",
      projectId: "project_1",
      displayName: "Lean",
      version: {
        id: "recipe_1",
        version: 1,
        projectId: "project_1",
        digest: "a".repeat(64),
        perCategoryLimits: { SOURCE: 1 },
        maximumReferences: 1,
        maximumPreviewBytes: 16,
        freshnessSeconds: 30,
        predecessorPolicy: "NONE",
      },
    });
    expect(recipe.ok).toBeTrue();
    expect(
      await presetStore.create({
        actorMemberId: "owner_1",
        displayName: "Implementation",
        version: presetVersion(),
      }),
    ).toMatchObject({ ok: true });
    const effective = resolveEffectiveRunConfiguration(presetVersion(), {
      runGoal: "Implement Task 11.",
      authoredRunInput: "Implement Task 11.",
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
        runnerEpoch: 2,
        mappingRevision: 1,
        profileId: "profile_1",
        profileVersion: 3,
        profileFingerprint: PROFILE_FINGERPRINT,
      },
    });
    expect(effective.ok).toBeTrue();
    if (!effective.ok || !recipe.ok) throw new Error("fixture failed");

    database.exec(`
      INSERT INTO coordination_records(id, project_id, title, revision, created_at, updated_at)
        VALUES ('coordination_1', 'project_1', 'Task 11', 1, 100, 100);
    `);
    database
      .query(
        `INSERT INTO agent_runs(
           id, coordination_record_id, project_id, state, goal, repository_id,
           repository_mode, repository_assurance, base_origin, base_commit, base_branch,
           intended_branch, worktree_identity, effective_configuration_id,
           effective_configuration_version, effective_configuration_digest, dispatcher_kind,
           dispatcher_id, revision, created_at
         ) VALUES (?, ?, ?, 'QUEUED', ?, 'repository_1', ?, ?, 'EXACT', ?, 'main', ?, ?, ?, ?, ?,
           'MEMBER', 'owner_1', 1, 100)`,
      )
      .run(
        "run_1",
        "coordination_1",
        "project_1",
        effective.value.layers.runGoal,
        effective.value.repositoryMode,
        effective.value.repositoryAssurance,
        "b".repeat(40),
        "collab/task-11",
        "worktree_1",
        effective.value.presetId,
        effective.value.presetVersion,
        effective.value.digest,
      );
    const envelope = assembleBootstrapEnvelope(
      recipe.value.version,
      [
        {
          category: "SOURCE",
          referenceId: "issue_1",
          canonicalKey: "github:issue:1",
          observedRevision: "rev_1",
          observedAt: 90,
          availability: "AVAILABLE",
          authority: "AUTHORIZED",
          priority: 1,
          authoredPreview: "bounded preview",
        },
      ],
      100,
    );
    expect(envelope.ok).toBeTrue();
    if (!envelope.ok) throw new Error("fixture failed");
    expect(
      configurationStore.persistRunSnapshot({
        runId: "run_1",
        configuration: effective.value,
        envelope: {
          ...envelope.value,
          references: [
            ...envelope.value.references,
            {
              category: "SOURCE",
              referenceId: "issue_2",
              observedRevision: "rev_2",
              status: "FRESH",
              authoredPreview: "exceeds stored budget",
            },
          ],
        },
        authoredRunInput: "Implement Task 11.",
      }),
    ).toMatchObject({ ok: false, error: { code: "CONTEXT_RECIPE_BUDGET_EXCEEDED" } });
    expect(
      database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM run_configuration_snapshots")
        .get()?.count,
    ).toBe(0);
    database.exec("UPDATE runners SET policy_revision = 2 WHERE id = 'runner_1'");
    expect(
      configurationStore.persistRunSnapshot({
        runId: "run_1",
        configuration: effective.value,
        envelope: envelope.value,
        authoredRunInput: "Implement Task 11.",
      }),
    ).toMatchObject({ ok: false, error: { code: "RUN_CONFIGURATION_AUTHORITY_STALE" } });
    database.exec("UPDATE runners SET policy_revision = 1 WHERE id = 'runner_1'");
    expect(
      configurationStore.persistRunSnapshot({
        runId: "run_1",
        configuration: effective.value,
        envelope: envelope.value,
        authoredRunInput: "Implement Task 11.",
      }),
    ).toMatchObject({ ok: true });

    await presetStore.edit({
      actorMemberId: "owner_1",
      presetId: "preset_1",
      expectedRevision: 1,
      version: presetVersion({ presetVersion: 2, maximumAttempts: 1 }),
    });
    const historical = configurationStore.inspectRunSnapshot("run_1");
    expect(historical).toMatchObject({
      ok: true,
      value: {
        configuration: { presetVersion: 1, maximumAttempts: 3, runtime: "CODEX" },
        envelope: { references: [{ referenceId: "issue_1", authoredPreview: "bounded preview" }] },
      },
    });
    expect(
      configurationStore.persistRunSnapshot({
        runId: "run_1",
        configuration: { ...effective.value, maximumAttempts: 1 },
        envelope: envelope.value,
        authoredRunInput: "rewrite",
      }),
    ).toMatchObject({ ok: false, error: { code: "RUN_CONFIGURATION_IMMUTABLE" } });

    database.close();
  });
});

describe("durable honest usage telemetry", () => {
  test("keeps eligible unknown attempts in coverage and rejects observation-id conflicts", () => {
    const database = databaseFixture();
    const usage = createUsageStore({ database, clock: () => 200, id: idFactory() });
    database.exec(`
      INSERT INTO coordination_records(id, project_id, title, revision, created_at, updated_at)
        VALUES ('coordination_1', 'project_1', 'Usage', 1, 100, 100);
      INSERT INTO agent_runs(
        id, coordination_record_id, project_id, state, goal, repository_id, repository_mode,
        repository_assurance, base_origin, base_commit, base_branch, intended_branch,
        worktree_identity, effective_configuration_id, effective_configuration_version,
        effective_configuration_digest, dispatcher_kind, dispatcher_id, revision, created_at,
        started_at
      ) VALUES (
        'run_1', 'coordination_1', 'project_1', 'RUNNING', 'Measure', 'repository_1',
        'INSPECT_ONLY', 'ADVISORY', 'EXACT', '${"b".repeat(40)}', 'main', NULL,
        'worktree_1', 'configuration_1', 1, '${"e".repeat(64)}', 'MEMBER', 'owner_1', 1, 100,
        100
      );
      INSERT INTO execution_attempts(
        id, run_id, project_id, ordinal, runner_id, runner_epoch, mapping_revision,
        profile_version_id, profile_version, profile_fingerprint, host, interaction, state,
        revision, created_at, acknowledged_at, started_at, terminal_at, terminal_reason
      ) VALUES
        ('attempt_1', 'run_1', 'project_1', 1, 'runner_1', 2, 1, 'profile_1', 3,
         '${PROFILE_FINGERPRINT}', 'ORCA', 'HEADLESS', 'LOST', 1, 100, 101, 102, 120, 'LOST'),
        ('attempt_2', 'run_1', 'project_1', 2, 'runner_1', 2, 1, 'profile_1', 3,
         '${PROFILE_FINGERPRINT}', 'ORCA', 'HEADLESS', 'RUNNING', 1, 121, 122, 123, NULL, NULL);
    `);
    expect(
      usage.recordEligibleAttempt({
        attemptId: "attempt_1",
        runtime: "CODEX",
        provider: "OPENAI",
        profileId: "profile_1",
        profileVersion: 3,
        declaredModel: "gpt-declared",
        startedAt: 102,
        endedAt: 120,
      }),
    ).toMatchObject({ ok: true });
    expect(
      usage.recordEligibleAttempt({
        attemptId: "attempt_2",
        runtime: "CODEX",
        provider: "OPENAI",
        profileId: "profile_1",
        profileVersion: 3,
        declaredModel: "gpt-declared",
        startedAt: 123,
      }),
    ).toMatchObject({ ok: true });
    const observed = {
      observationId: "structured_1",
      attemptId: "attempt_1",
      runtime: "CODEX",
      provider: "OPENAI",
      modelIdentifier: "gpt-reported",
      category: "OUTPUT" as const,
      units: 0,
      observedAt: 120,
    };
    expect(usage.appendObservation(observed)).toMatchObject({ ok: true });
    expect(usage.appendObservation(observed)).toMatchObject({ ok: true });
    expect(usage.appendObservation({ ...observed, units: 99 })).toMatchObject({
      ok: false,
      error: { code: "USAGE_OBSERVATION_CONFLICT" },
    });
    expect(usage.aggregate()).toEqual([
      {
        runtime: "CODEX",
        provider: "OPENAI",
        modelIdentifier: "gpt-reported",
        category: "OUTPUT",
        knownUnits: 0,
        knownAttempts: 1,
        totalAttempts: 1,
        coverage: "COMPLETE",
      },
    ]);
    expect(JSON.stringify(usage.aggregate())).not.toMatch(/cost|currency|pricing/i);
    expect(aggregateUsage(usage.eligibleAttempts(), usage.observations())).toEqual(
      usage.aggregate(),
    );

    database.close();
  });
});
