import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionComposition } from "../../src/server/dependencies.ts";
import { openDatabase } from "../../src/server/db/connection.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { computeContextRecipeDigest } from "../../src/server/modules/context/context-recipes.ts";
import { resolveEffectiveRunConfiguration } from "../../src/server/modules/presets/configuration-resolver.ts";
import type { ServerEnvironment } from "../../src/shared/environment.ts";
import { CollabCommandSchema } from "../../src/shared/contracts/commands.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production repository base resolution", () => {
  test("uses the authenticated runner's fresh exact mapping observation for a first run", async () => {
    const root = mkdtempSync(join(tmpdir(), "2collab-repository-base-"));
    roots.push(root);
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const bootstrapSecretFile = join(root, "bootstrap-secret");
    writeFileSync(bootstrapSecretFile, "bootstrap-secret-with-at-least-thirty-two-bytes\n");
    const now = Math.floor(Date.now() / 1_000);
    const sessionProof = "member-session-proof-with-at-least-thirty-two-bytes";
    const securityDigest = "d".repeat(64);
    const profileFingerprint = "c".repeat(64);
    const baseCommit = "a".repeat(40);
    const recipe = {
      id: "recipe_1",
      version: 1,
      projectId: "project_1",
      perCategoryLimits: {},
      maximumReferences: 1,
      maximumPreviewBytes: 0,
      freshnessSeconds: 30,
      predecessorPolicy: "NONE" as const,
    };
    const recipeDigest = computeContextRecipeDigest(recipe);
    const runTemplate = {
      name: "Inspect repository",
      coreInstructions: "Inspect the selected repository and return a typed result.",
      variables: [],
      resultKeys: ["DONE"],
      repositoryMode: "INSPECT_ONLY",
      minimumAssurance: "ADVISORY",
      gateSets: [],
      maximumAttempts: 1,
      absoluteDeadlineMs: 60_000,
    };
    const workflowDefinition = {
      inputs: [],
      nodes: [
        { kind: "START", key: "start" },
        {
          kind: "AGENT_RUN",
          key: "inspect",
          runTemplateVersionId: "run_template_1",
          resultKeys: ["DONE"],
        },
        { kind: "TERMINAL", key: "done", outcome: "COMPLETED" },
      ],
      transitions: [
        { from: "start", resultKey: "STARTED", to: "inspect" },
        { from: "inspect", resultKey: "DONE", to: "done" },
      ],
      maximumRunCount: 1,
      cycleBounds: {},
      maximumParallelBranches: 1,
      maximumConcurrency: 1,
      absoluteDeadlineMs: 60_000,
    };
    const database = openDatabase(join(dataDir, "collab.sqlite"));
    migrate(database);
    database.exec(`
      INSERT INTO deployments(id, singleton, team_id, revision, created_at)
        VALUES ('deployment_1', 1, 'team_1', 1, ${now});
      INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
        VALUES ('member_1', 'Member', 'OWNER', 'ACTIVE', 1, 1, ${now});
      INSERT INTO sessions(
        id, member_id, proof_hash, kind, expires_at, idle_expires_at, csrf_hash,
        absolute_expires_at, member_authority_epoch, revision, created_at
      ) VALUES (
        'session_1', 'member_1', X'${createHash("sha256").update(sessionProof).digest("hex")}',
        'BROWSER', ${now + 3600}, ${now + 3600}, zeroblob(32), ${now + 3600}, 1, 1, ${now}
      );
      INSERT INTO projects(id, team_id, name, base_branch, revision, created_at)
        VALUES ('project_1', 'team_1', 'Project', 'main', 1, ${now});
      INSERT INTO runners(
        id, owner_member_id, runner_epoch, policy_revision, dispatch_audience,
        maximum_concurrent_attempts, security_policy_version, security_digest,
        revision, created_at, last_heartbeat_at
      ) VALUES (
        'runner_1', 'member_1', 1, 1, 'OWNER_ONLY', 1, 1, '${securityDigest}',
        1, ${now}, ${now}
      );
      INSERT INTO runner_mapping_versions(runner_id, project_id, revision, local_mapping_id, created_at)
        VALUES ('runner_1', 'project_1', 1, 'mapping_1', ${now});
      INSERT INTO runner_repository_observations(
        runner_id, runner_epoch, project_id, mapping_revision, base_branch, base_commit, observed_at
      ) VALUES ('runner_1', 1, 'project_1', 1, 'main', '${baseCommit}', ${now});
      INSERT INTO safe_profile_versions(
        runner_id, profile_id, version, display_name, adapter, supports_native, supports_orca,
        supports_headless, supports_interactive, risk_summary, fingerprint, created_at
      ) VALUES (
        'runner_1', 'profile_1', 1, 'Safe profile', 'CODEX', 1, 0, 1, 0,
        'Trusted local execution', '${profileFingerprint}', ${now}
      );
      INSERT INTO personal_run_presets(
        id, owner_member_id, project_id, display_name, state, current_version,
        revision, created_at, updated_at
      ) VALUES ('preset_1', 'member_1', 'project_1', 'Preset', 'ACTIVE', 1, 1, ${now}, ${now});
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
        'preset_1', 1, NULL, NULL, 'runner_1', 1, 1, 'profile_1', 1,
        '${profileFingerprint}', 'NATIVE', 'HEADLESS', 'INSPECT_ONLY', 'ADVISORY',
        'ONCE', 1, 900, NULL, NULL, NULL, NULL, NULL, NULL, 'recipe_1', 1,
        NULL, NULL, NULL, '${"e".repeat(64)}', ${now}
      );
      INSERT INTO context_recipes(
        id, project_id, display_name, current_version, state, revision, created_at, updated_at
      ) VALUES ('recipe_1', 'project_1', 'Recipe', 1, 'ACTIVE', 1, ${now}, ${now});
      INSERT INTO context_recipe_versions(
        recipe_id, version, include_goal, include_coordination, include_sources,
        include_repository, include_predecessor_evidence, maximum_references,
        maximum_preview_bytes, freshness_seconds, predecessor_policy, recipe_digest, created_at
      ) VALUES ('recipe_1', 1, 1, 0, 0, 0, 0, 1, 0, 30, 'NONE', '${recipeDigest}', ${now});
    `);
    database
      .query(
        `INSERT INTO team_run_template_versions(
           id, template_key, version, project_id, definition_json, semantic_hash,
           published_by_member_id, published_at
         ) VALUES ('run_template_1', 'inspect_repository', 1, 'project_1', ?, ?, 'member_1', ?)`,
      )
      .run(JSON.stringify(runTemplate), "1".repeat(64), now);
    database
      .query(
        `INSERT INTO team_workflow_template_versions(
           id, template_key, version, definition_json, semantic_hash,
           published_by_member_id, published_at
         ) VALUES ('workflow_template_1', 'inspect_workflow', 1, ?, ?, 'member_1', ?)`,
      )
      .run(JSON.stringify(workflowDefinition), "2".repeat(64), now);
    database
      .query(
        `INSERT INTO personal_workflow_presets(
           id, owner_member_id, version, workflow_template_version_id, bindings_json, created_at
         ) VALUES ('workflow_preset_1', 'member_1', 1, 'workflow_template_1', ?, ?)`,
      )
      .run(
        JSON.stringify({
          inspect: {
            personalRunPresetId: "preset_1",
            expectedVersion: 1,
            repository: {
              repositoryId: "repository_1",
              intendedBranch: "collab/workflow-inspect",
            },
          },
        }),
        now,
      );
    database.close();

    const environment: ServerEnvironment = {
      backupDir: join(root, "backups"),
      bootstrapSecretFile,
      dataDir,
      deploymentMasterKeyFile: undefined,
      hostname: "127.0.0.1",
      mode: "development",
      port: 0,
      publicBaseUrl: "http://localhost:3210",
      rpId: "localhost",
      rpName: "2Collab Test",
      runnerCompositionModule: undefined,
      sessionSecret: undefined,
    };
    const server = await createProductionComposition(environment);
    try {
      const configuration = resolveEffectiveRunConfiguration(
        {
          presetId: "preset_1",
          presetVersion: 1,
          ownerMemberId: "member_1",
          projectId: "project_1",
          runtime: "CODEX",
          runnerId: "runner_1",
          runnerEpoch: 1,
          mappingRevision: 1,
          profileId: "profile_1",
          profileVersion: 1,
          profileFingerprint,
          host: "NATIVE",
          interaction: "HEADLESS",
          repositoryMode: "INSPECT_ONLY",
          repositoryAssurance: "ADVISORY",
          executionPolicy: "ONCE",
          maximumAttempts: 1,
          deadlineSeconds: 900,
          contextRecipeId: "recipe_1",
          contextRecipeVersion: 1,
          requiredGates: [],
        },
        {
          runGoal: "Inspect the repository.",
          authorityFacts: {
            projectRevision: 1,
            runnerPolicyRevision: 1,
            securityPolicyVersion: 1,
            securityDigest: securityDigest as never,
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
            profileFingerprint,
          },
        },
      );
      if (!configuration.ok) throw new Error(configuration.error.code);
      const command = {
        kind: "LAUNCH_RUN",
        idempotencyKey: "launch_with_observed_base" as never,
        actor: {
          kind: "MEMBER",
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof,
        },
        projectId: "project_1" as never,
        coordination: { kind: "NEW", title: "First run", sourceRefs: [] },
        goal: "Inspect the repository.",
        repository: {
          repositoryId: "repository_1" as never,
          mode: "INSPECT_ONLY",
          assurance: "ADVISORY",
          base: { kind: "RESOLVE_DEFAULT_BASE" },
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
          digest: configuration.value.digest,
        },
      } as const;
      const parsed = CollabCommandSchema.safeParse(command);
      expect(
        parsed.success,
        parsed.success ? undefined : JSON.stringify(parsed.error.issues),
      ).toBeTrue();
      const launched = await server.authority.execute(command as never);
      expect(launched).toMatchObject({ ok: true, value: { kind: "LAUNCH_RUN" } });
      expect(
        server.database
          .query<{ base_commit: string }, []>("SELECT base_commit FROM agent_runs")
          .get(),
      ).toEqual({ base_commit: baseCommit });

      const workflow = await server.components.automation.engine.start({
        idempotencyKey: "start_stored_workflow",
        workflowExecutionId: "workflow_execution_1",
        coordinationRecordId: server.database
          .query<{ id: string }, []>("SELECT id FROM coordination_records LIMIT 1")
          .get()?.id as never,
        coordinationRevision: 1,
        templateVersionId: "workflow_template_1",
        presetVersionId: "workflow_preset_1_v1",
        workflowPresetId: "workflow_preset_1",
        workflowPresetVersion: 1,
        schedulerActor: {
          kind: "SCHEDULER",
          originalDispatcherId: "member_1" as never,
          workflowExecutionId: "workflow_execution_1" as never,
        },
      });
      expect(workflow).toMatchObject({ ok: true, value: { id: "workflow_execution_1" } });
      const snapshot = JSON.parse(
        server.database
          .query<{ snapshot_json: string }, []>(
            "SELECT snapshot_json FROM workflow_executions WHERE id = 'workflow_execution_1'",
          )
          .get()?.snapshot_json ?? "null",
      );
      expect(snapshot.launches.inspect).toMatchObject({
        projectId: "project_1",
        repository: {
          repositoryId: "repository_1",
          intendedBranch: "collab/workflow-inspect",
          base: { kind: "RESOLVE_DEFAULT_BASE" },
        },
        execution: { runnerId: "runner_1", projectMappingRevision: 1 },
      });
    } finally {
      server.database.close();
    }
  });
});
