import { expect, test } from "bun:test";
import type { ExecutionAuthority } from "../../../src/shared/contracts/execution-authority.ts";
import { createApprovedManifestLoader } from "../../../src/runner/gates/manifest-loader.ts";
import { evaluateLocalGate } from "../../../src/runner/gates/local-evaluator.ts";
import { fingerprintGateManifest } from "../../../src/server/modules/gates/fingerprints.ts";
import { parseTrustedGateManifest } from "../../../src/server/modules/gates/manifest.ts";

const revision = "a".repeat(40);
const headRevision = "b".repeat(40);
const parsed = parseTrustedGateManifest({
  source: `version=1
[[gates]]
key="unit"
kind="LOCAL_COMMAND"
executable="bun"
arguments=["test"]
working_directory="."
timeout_ms=1000
max_output_bytes=1024
[sets]
pr_ready=["unit"]`,
  manifestRevision: revision,
  trustedBaseRevision: revision,
});
if (!parsed.ok) throw new Error("fixture invalid");
const fingerprint = fingerprintGateManifest(parsed.value.manifest);

function harness(result = { exitCode: 0, output: "ok", trackedMutation: false }) {
  const commands: unknown[] = [];
  const spawns: unknown[] = [];
  const authority = {
    execute: async (command: unknown) => {
      commands.push(command);
      return { ok: true as const, value: { kind: "AUTHORIZE_OPERATION" as const } };
    },
  } as unknown as ExecutionAuthority;
  const spawn = async (argv: readonly string[], options: unknown) => {
    spawns.push({ argv, options });
    return result;
  };
  return { authority, commands, spawns, spawn };
}

test("resolves the approved recipe locally, authorizes it, and never invokes a shell", async () => {
  const loader = createApprovedManifestLoader();
  loader.approve({
    projectId: "project_1",
    baseRevision: revision,
    fingerprint,
    manifest: parsed.value.manifest,
  });
  const h = harness();
  const result = await evaluateLocalGate(
    {
      gateEvaluationId: "evaluation_1",
      gateKey: "unit",
      repositoryRevision: headRevision,
      manifestFingerprint: fingerprint,
    },
    {
      loader,
      authority: h.authority,
      runnerActor: { kind: "RUNNER", runnerId: "runner_1", runnerEpoch: 1 } as never,
      sessionId: "session_1" as never,
      sessionFence: 2,
      idempotencyKey: "gate_evaluation_1" as never,
      projectId: "project_1",
      trustedBaseRevision: revision,
      observedRepositoryRevision: headRevision,
      opaqueWorktreeId: "worktree_1",
      spawn: h.spawn,
    },
  );
  expect(result).toMatchObject({ ok: true, value: { state: "PASSED", exitCode: 0 } });
  expect(h.commands).toHaveLength(1);
  expect(h.spawns).toEqual([
    {
      argv: ["bun", "test"],
      options: {
        cwd: "worktree_1",
        relativeDirectory: ".",
        timeoutMs: 1000,
        maxOutputBytes: 1024,
        shell: false,
      },
    },
  ]);
});

test("rejects stale fingerprints before authority or process start", async () => {
  const loader = createApprovedManifestLoader();
  loader.approve({
    projectId: "project_1",
    baseRevision: revision,
    fingerprint,
    manifest: parsed.value.manifest,
  });
  const h = harness();
  expect(
    await evaluateLocalGate(
      {
        gateEvaluationId: "evaluation_1",
        gateKey: "unit",
        repositoryRevision: headRevision,
        manifestFingerprint: "b".repeat(64),
      },
      {
        loader,
        authority: h.authority,
        runnerActor: { kind: "RUNNER", runnerId: "runner_1", runnerEpoch: 1 } as never,
        sessionId: "session_1" as never,
        sessionFence: 2,
        idempotencyKey: "gate_evaluation_1" as never,
        projectId: "project_1",
        trustedBaseRevision: revision,
        observedRepositoryRevision: headRevision,
        opaqueWorktreeId: "worktree_1",
        spawn: h.spawn,
      },
    ),
  ).toMatchObject({ ok: false, error: { code: "GATE_FINGERPRINT_STALE" } });
  expect(h.commands).toHaveLength(0);
  expect(h.spawns).toHaveLength(0);
});

test("rejects a server-transmitted command before authority or process start", async () => {
  const loader = createApprovedManifestLoader();
  loader.approve({
    projectId: "project_1",
    baseRevision: revision,
    fingerprint,
    manifest: parsed.value.manifest,
  });
  const h = harness();
  expect(
    await evaluateLocalGate(
      {
        gateEvaluationId: "evaluation_1",
        gateKey: "unit",
        repositoryRevision: headRevision,
        manifestFingerprint: fingerprint,
        command: ["bun", "test", "--skip-security"],
      } as never,
      {
        loader,
        authority: h.authority,
        runnerActor: { kind: "RUNNER", runnerId: "runner_1", runnerEpoch: 1 } as never,
        sessionId: "session_1" as never,
        sessionFence: 2,
        idempotencyKey: "gate_evaluation_1" as never,
        projectId: "project_1",
        trustedBaseRevision: revision,
        observedRepositoryRevision: headRevision,
        opaqueWorktreeId: "worktree_1",
        spawn: h.spawn,
      },
    ),
  ).toMatchObject({ ok: false, error: { code: "GATE_REQUEST_INVALID" } });
  expect(h.commands).toHaveLength(0);
  expect(h.spawns).toHaveLength(0);
});

test("rejects replay without launching a second process", async () => {
  const loader = createApprovedManifestLoader();
  loader.approve({
    projectId: "project_1",
    baseRevision: revision,
    fingerprint,
    manifest: parsed.value.manifest,
  });
  const h = harness();
  const request = {
    gateEvaluationId: "evaluation_replay",
    gateKey: "unit",
    repositoryRevision: headRevision,
    manifestFingerprint: fingerprint,
  };
  const context = {
    loader,
    authority: h.authority,
    runnerActor: { kind: "RUNNER", runnerId: "runner_1", runnerEpoch: 1 } as never,
    sessionId: "session_1" as never,
    sessionFence: 2,
    idempotencyKey: "gate_replay" as never,
    projectId: "project_1",
    trustedBaseRevision: revision,
    observedRepositoryRevision: headRevision,
    opaqueWorktreeId: "worktree_1",
    spawn: h.spawn,
  };
  expect(await evaluateLocalGate(request, context)).toMatchObject({ ok: true });
  expect(await evaluateLocalGate(request, context)).toMatchObject({
    ok: false,
    error: { code: "GATE_EVALUATION_REPLAY" },
  });
  expect(h.spawns).toHaveLength(1);
});

test("tracked mutations, timeout, and cancellation fail closed", async () => {
  for (const [processResult, state] of [
    [{ exitCode: 0, output: "changed", trackedMutation: true }, "FAILED"],
    [{ exitCode: null, output: "late", trackedMutation: false, timedOut: true }, "TIMED_OUT"],
    [{ exitCode: null, output: "stopped", trackedMutation: false, cancelled: true }, "CANCELLED"],
  ] as const) {
    const loader = createApprovedManifestLoader();
    loader.approve({
      projectId: "project_1",
      baseRevision: revision,
      fingerprint,
      manifest: parsed.value.manifest,
    });
    const h = harness(processResult as never);
    expect(
      await evaluateLocalGate(
        {
          gateEvaluationId: `evaluation_${state}`,
          gateKey: "unit",
          repositoryRevision: headRevision,
          manifestFingerprint: fingerprint,
        },
        {
          loader,
          authority: h.authority,
          runnerActor: { kind: "RUNNER", runnerId: "runner_1", runnerEpoch: 1 } as never,
          sessionId: "session_1" as never,
          sessionFence: 2,
          idempotencyKey: `gate_${state}` as never,
          projectId: "project_1",
          trustedBaseRevision: revision,
          observedRepositoryRevision: headRevision,
          opaqueWorktreeId: "worktree_1",
          spawn: h.spawn,
        },
      ),
    ).toMatchObject({ ok: true, value: { state } });
  }
});
