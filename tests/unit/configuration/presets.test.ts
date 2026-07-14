import { describe, expect, test } from "bun:test";
import {
  resolveEffectiveRunConfiguration,
  validatePersonalRunPresetVersion,
} from "../../../src/server/modules/presets/configuration-resolver.ts";

const base = {
  presetId: "preset_1",
  presetVersion: 1,
  ownerMemberId: "member_1",
  projectId: "project_1",
  runtime: "CODEX" as const,
  runnerId: "runner_1",
  runnerEpoch: 2,
  mappingRevision: 1,
  profileId: "profile_1",
  profileVersion: 3,
  profileFingerprint: "a".repeat(64),
  host: "ORCA" as const,
  interaction: "HEADLESS" as const,
  repositoryMode: "MUTATING" as const,
  repositoryAssurance: "ADVISORY" as const,
  executionPolicy: "ONCE" as const,
  maximumAttempts: 3,
  deadlineSeconds: 3_600,
  contextRecipeId: "recipe_1",
  contextRecipeVersion: 1,
  requiredGates: ["unit", "lint"],
  gateManifestFingerprint: "b".repeat(64) as never,
  personalAddendum: "Keep the implementation narrowly scoped.",
};

const trustedResolution = {
  authorityFacts: {
    projectRevision: 4,
    runnerPolicyRevision: 5,
    securityPolicyVersion: 6,
    securityDigest: "c".repeat(64) as never,
    connectorEpochs: { github_1: 7 },
    grantIds: ["grant_1"],
  },
  currentBinding: {
    projectId: "project_1",
    runnerId: "runner_1",
    runnerEpoch: 2,
    mappingRevision: 1,
    profileId: "profile_1",
    profileVersion: 3,
    profileFingerprint: "a".repeat(64),
  },
} as const;

describe("personal run preset resolution", () => {
  test("rejects local command, environment, credential, and hidden prompt fields", () => {
    for (const forbidden of [
      { executable: "/bin/sh" },
      { arguments: ["--dangerously-skip-permissions"] },
      { environment: { TOKEN: "secret" } },
      { credential: "secret" },
      { profileInstructions: "hidden prompt" },
    ]) {
      expect(validatePersonalRunPresetVersion({ ...base, ...forbidden } as never)).toMatchObject({
        ok: false,
        error: { code: "PRESET_PRIVATE_CONFIGURATION" },
      });
    }
    for (const invalid of [
      { runtime: "SHELL" },
      { host: "REMOTE" },
      { interaction: "AUTO" },
      { repositoryMode: "WRITE" },
      { repositoryAssurance: "HARD" },
      { executionPolicy: "FOREVER" },
    ]) {
      expect(validatePersonalRunPresetVersion({ ...base, ...invalid } as never)).toMatchObject({
        ok: false,
        error: { code: "PRESET_INVALID" },
      });
    }
  });

  test("allows visible overrides to narrow but never widen authority or hard bounds", () => {
    const narrowed = resolveEffectiveRunConfiguration(base, {
      ...trustedResolution,
      repositoryMode: "INSPECT_ONLY",
      maximumAttempts: 1,
      deadlineSeconds: 600,
      requiredGates: ["unit", "lint", "security"],
      runGoal: "Review the implementation.",
    });
    expect(narrowed).toMatchObject({
      ok: true,
      value: {
        presetVersion: 1,
        repositoryMode: "INSPECT_ONLY",
        maximumAttempts: 1,
        deadlineSeconds: 600,
        requiredGates: ["lint", "security", "unit"],
      },
    });
    if (!narrowed.ok) throw new Error(narrowed.error.code);
    expect(narrowed.value.digest).toHaveLength(64);
    expect(narrowed.value.layers.personalAddendum).toBe(base.personalAddendum);
    expect(narrowed.value.layers.runGoal).toBe("Review the implementation.");

    expect(
      resolveEffectiveRunConfiguration(base, {
        ...trustedResolution,
        repositoryAssurance: "ENFORCED",
        maximumAttempts: 4,
        deadlineSeconds: 7_200,
        requiredGates: ["unit"],
        runGoal: "Widen the run.",
      }),
    ).toMatchObject({ ok: false, error: { code: "CONFIGURATION_WIDENING_DENIED" } });
  });

  test("fails stale bindings instead of substituting a runtime, runner, or profile", () => {
    expect(
      resolveEffectiveRunConfiguration(base, { runGoal: "Implement the change." }),
    ).toMatchObject({
      ok: false,
      error: { code: "PRESET_BINDING_REQUIRED" },
    });
    expect(
      resolveEffectiveRunConfiguration(base, {
        authorityFacts: trustedResolution.authorityFacts,
        runGoal: "Implement the change.",
        currentBinding: {
          projectId: "project_1",
          runnerId: "runner_1",
          runnerEpoch: 3,
          mappingRevision: 1,
          profileId: "profile_1",
          profileVersion: 3,
          profileFingerprint: "a".repeat(64),
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "PRESET_BINDING_STALE" } });
  });

  test("binds a projectless preset to the explicit trusted current project", () => {
    const resolved = resolveEffectiveRunConfiguration(
      { ...base, projectId: undefined },
      { ...trustedResolution, runGoal: "Run in the selected project." },
    );
    expect(resolved).toMatchObject({ ok: true, value: { projectId: "project_1" } });
    expect(
      resolveEffectiveRunConfiguration(base, {
        ...trustedResolution,
        currentBinding: { ...trustedResolution.currentBinding, projectId: "project_2" },
        runGoal: "Run elsewhere.",
      }),
    ).toMatchObject({ ok: false, error: { code: "PRESET_BINDING_STALE" } });
  });

  test("rejects stale mappings, invalid goals, fractional bounds, and malformed added gates", () => {
    expect(
      resolveEffectiveRunConfiguration(base, {
        authorityFacts: trustedResolution.authorityFacts,
        runGoal: "Implement.",
        currentBinding: {
          projectId: "project_1",
          runnerId: "runner_1",
          runnerEpoch: 2,
          mappingRevision: 2,
          profileId: "profile_1",
          profileVersion: 3,
          profileFingerprint: "a".repeat(64),
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "PRESET_BINDING_STALE" } });
    for (const overrides of [
      { runGoal: "" },
      { runGoal: "x".repeat(16_385) },
      { runGoal: "Implement.", maximumAttempts: 1.5 },
      { runGoal: "Implement.", deadlineSeconds: 1.5 },
      { runGoal: "Implement.", requiredGates: ["bad gate"] },
    ]) {
      expect(
        resolveEffectiveRunConfiguration(base, { ...trustedResolution, ...overrides }),
      ).toMatchObject({
        ok: false,
      });
    }
  });

  test("keeps team core, typed variables, personal addendum, run input, and authority provenance separate", () => {
    const result = resolveEffectiveRunConfiguration(
      { ...base, derivedTemplate: { id: "template_1", version: 2 } },
      {
        ...trustedResolution,
        runGoal: "Implement the selected change.",
        authoredRunInput: "Only touch the requested module.",
        teamTemplate: {
          id: "template_1",
          version: 2,
          coreInstructions: "Follow the shared implementation contract.",
          typedVariables: { issueNumber: 42, includeTests: true },
        },
      },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        layers: {
          teamCore: "Follow the shared implementation contract.",
          typedVariables: { issueNumber: 42, includeTests: true },
          personalAddendum: base.personalAddendum,
          runGoal: "Implement the selected change.",
          authoredRunInput: "Only touch the requested module.",
        },
        provenance: {
          preset: { id: "preset_1", version: 1 },
          teamTemplate: { id: "template_1", version: 2 },
          binding: { runnerEpoch: 2, mappingRevision: 1, profileVersion: 3 },
          authority: { projectRevision: 4, connectorEpochs: { github_1: 7 } },
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /flattenedPrompt|executable|environment|credential/i,
    );
    expect(
      resolveEffectiveRunConfiguration(
        { ...base, derivedTemplate: { id: "template_1", version: 2 } },
        {
          ...trustedResolution,
          runGoal: "Implement.",
          teamTemplate: {
            id: "template_1",
            version: 3,
            coreInstructions: "Changed",
            typedVariables: {},
          },
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "PRESET_TEMPLATE_STALE" } });
  });
});
