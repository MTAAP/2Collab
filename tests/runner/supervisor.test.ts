import { describe, expect, test } from "bun:test";
import { createRunnerSupervisor } from "../../src/runner/supervisor.ts";
import { createCodexExecutionAdapter } from "../../src/runner/adapters/runtime/codex.ts";
import { createNativeExecutionHost } from "../../src/runner/adapters/host/native.ts";
import { createRunnerEnvironmentBuilder } from "../../src/runner/environment.ts";
import type { RunnerEnvelope } from "../../src/shared/contracts/protocol.ts";

const profile = {
  adapter: "CODEX",
  executable: "/opt/collab/bin/codex",
  fixedArguments: ["--model", "gpt-5"],
  promptTransport: { headless: "STDIN", interactive: "TERMINAL_INPUT" },
  supportedInteractions: ["HEADLESS", "INTERACTIVE"],
  fingerprint: "a".repeat(64),
} as const;

function outputTransport(sent: RunnerEnvelope[] = []) {
  let message = 0;
  return {
    protocolVersion: "1.0",
    now: () => 1_000,
    messageId: () => `output_message_${++message}`,
    send: async (envelope: RunnerEnvelope) => {
      sent.push(envelope);
    },
  };
}

describe("runner supervisor", () => {
  test("consumes a permit immediately before one reserved process start", async () => {
    const order: string[] = [];
    const output: RunnerEnvelope[] = [];
    let starts = 0;
    const host = createNativeExecutionHost({
      async start(input) {
        order.push("start");
        starts += 1;
        expect(input.worktree.id).toBe("worktree_1");
        expect(input.environment).toEqual({ HOME: "/safe/home", PATH: "/usr/bin:/bin" });
        await input.headlessOutput?.({ kind: "STDOUT", text: "token ghp_aaaaaaaaaa" });
        await input.headlessOutput?.({
          kind: "STDOUT",
          text: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        });
        await input.headlessOutput?.({ kind: "EXIT", exitCode: 0, signal: null });
        return { opaqueProcessId: "process_1" };
      },
      async cancel() {
        return true;
      },
      async inspect() {
        return "RUNNING";
      },
      async attach() {
        return { localAttachmentId: "attachment_1" };
      },
    });
    const supervisor = createRunnerSupervisor({
      profiles: {
        resolve() {
          order.push("profile");
          return { ok: true, value: profile };
        },
      },
      processes: {
        reserve() {
          order.push("reserve");
          return { ok: true, value: { reservationId: "reservation_1", disposition: "NEW" } };
        },
        release: () => ({ ok: true, value: undefined }),
        recordFailed: () => ({ ok: true, value: undefined }),
        markStarting() {
          order.push("starting");
          return { ok: true, value: undefined };
        },
        recordStarted() {
          order.push("record");
          return { ok: true, value: undefined };
        },
      },
      worktrees: {
        async resolveRunWorktree() {
          order.push("worktree");
          return { ok: true, value: { id: "worktree_1" } };
        },
      },
      environment: {
        build() {
          order.push("environment");
          return { ok: true, value: { HOME: "/safe/home", PATH: "/usr/bin:/bin" } };
        },
        validate: () => true,
      },
      enforcement: {
        assurance: "ADVISORY",
        async activate() {
          order.push("enforcement");
          return { ok: true, value: { sessionId: "enforcement_1" } };
        },
        async inspect() {
          return { ok: true, value: { state: "ACTIVE" as const, assurance: "ADVISORY" as const } };
        },
        async revoke() {
          return { ok: true, value: undefined };
        },
      },
      permits: {
        async consume() {
          order.push("permit");
          return { ok: true, value: { consumed: true } };
        },
      },
      adapters: { CODEX: createCodexExecutionAdapter() },
      hosts: { NATIVE: host },
      clock: () => 1_000,
      output: outputTransport(output),
    });

    const result = await supervisor.launch({
      runId: "run_1",
      attemptId: "attempt_1",
      assignmentDigest: "b".repeat(64),
      worktreeKey: "worktree_key_1",
      profileVersionId: "profile_version_1",
      expectedProfileFingerprint: profile.fingerprint,
      runtime: "CODEX",
      host: "NATIVE",
      interaction: "HEADLESS",
      assurance: "ADVISORY",
      instructions: "Review the repository",
      maximumRuntimeSeconds: 600,
      deadlineAt: 2_000,
      dispatchPermit: "permit_secret",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { process: { opaqueProcessId: "process_1" } },
    });
    expect(order).toEqual([
      "profile",
      "worktree",
      "environment",
      "enforcement",
      "reserve",
      "permit",
      "starting",
      "start",
      "record",
    ]);
    expect(starts).toBe(1);
    expect(JSON.stringify(output)).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(JSON.stringify(output)).not.toContain("ghp_");
  });

  test("never consumes or starts for enforced assurance or changed assignment reuse", async () => {
    let permits = 0;
    let starts = 0;
    const supervisor = createRunnerSupervisor({
      profiles: { resolve: () => ({ ok: true, value: profile }) },
      processes: {
        reserve: () => ({
          ok: false,
          error: {
            code: "PROCESS_ASSIGNMENT_CONFLICT",
            message: "Assignment changed.",
            retry: "NEVER",
          },
        }),
        release: () => ({ ok: true, value: undefined }),
        recordFailed: () => ({ ok: true, value: undefined }),
        markStarting: () => ({ ok: true, value: undefined }),
        recordStarted: () => ({ ok: true, value: undefined }),
      },
      worktrees: { resolveRunWorktree: async () => ({ ok: true, value: { id: "worktree_1" } }) },
      environment: { build: () => ({ ok: true, value: {} }), validate: () => true },
      enforcement: {
        assurance: "ADVISORY",
        activate: async () => ({ ok: true, value: { sessionId: "enforcement_1" } }),
        inspect: async () => ({
          ok: true,
          value: { state: "ACTIVE" as const, assurance: "ADVISORY" as const },
        }),
        revoke: async () => ({ ok: true, value: undefined }),
      },
      clock: () => 1_000,
      permits: {
        async consume() {
          permits += 1;
          return { ok: true, value: { consumed: true } };
        },
      },
      adapters: { CODEX: createCodexExecutionAdapter() },
      hosts: {
        NATIVE: createNativeExecutionHost({
          async start() {
            starts += 1;
            return { opaqueProcessId: "process_1" };
          },
          async cancel() {
            return true;
          },
          async inspect() {
            return "RUNNING";
          },
          async attach() {
            return { localAttachmentId: "attachment_1" };
          },
        }),
      },
      output: outputTransport(),
    });
    const base = {
      runId: "run_1",
      attemptId: "attempt_1",
      assignmentDigest: "b".repeat(64),
      worktreeKey: "worktree_key_1",
      profileVersionId: "profile_version_1",
      expectedProfileFingerprint: profile.fingerprint,
      runtime: "CODEX" as const,
      host: "NATIVE" as const,
      interaction: "HEADLESS" as const,
      assurance: "ADVISORY" as const,
      instructions: "Review",
      maximumRuntimeSeconds: 600,
      deadlineAt: 2_000,
      dispatchPermit: "permit_secret",
    };
    expect(await supervisor.launch({ ...base, assurance: "ENFORCED" })).toMatchObject({
      ok: false,
      error: { code: "ASSURANCE_UNAVAILABLE" },
    });
    expect(await supervisor.launch(base)).toMatchObject({
      ok: false,
      error: { code: "PROCESS_ASSIGNMENT_CONFLICT" },
    });
    expect({ permits, starts }).toEqual({ permits: 0, starts: 0 });
  });

  test("rejects an expired deadline before permit consumption or process start", async () => {
    let permits = 0;
    let starts = 0;
    const supervisor = createRunnerSupervisor({
      profiles: { resolve: () => ({ ok: true, value: profile }) },
      processes: {
        reserve: () => ({
          ok: true,
          value: { reservationId: "reservation_1", disposition: "NEW" },
        }),
        release: () => ({ ok: true, value: undefined }),
        recordFailed: () => ({ ok: true, value: undefined }),
        markStarting: () => ({ ok: true, value: undefined }),
        recordStarted: () => ({ ok: true, value: undefined }),
      },
      worktrees: { resolveRunWorktree: async () => ({ ok: true, value: { id: "worktree_1" } }) },
      environment: { build: () => ({ ok: true, value: {} }), validate: () => true },
      enforcement: {
        assurance: "ADVISORY",
        activate: async () => ({ ok: true, value: { sessionId: "enforcement_1" } }),
        inspect: async () => ({ ok: true, value: { state: "ACTIVE", assurance: "ADVISORY" } }),
        revoke: async () => ({ ok: true, value: undefined }),
      },
      permits: {
        consume: async () => {
          permits += 1;
          return { ok: true, value: { consumed: true } };
        },
      },
      adapters: { CODEX: createCodexExecutionAdapter() },
      hosts: {
        NATIVE: createNativeExecutionHost({
          start: async () => {
            starts += 1;
            return { opaqueProcessId: "process_1" };
          },
          cancel: async () => true,
          inspect: async () => "RUNNING",
          attach: async () => ({ localAttachmentId: "attachment_1" }),
        }),
      },
      clock: () => 1_000,
      output: outputTransport(),
    });
    const result = await supervisor.launch({
      runId: "run_1",
      attemptId: "attempt_1",
      assignmentDigest: "b".repeat(64),
      worktreeKey: "worktree_1",
      profileVersionId: "profile_1",
      expectedProfileFingerprint: profile.fingerprint,
      runtime: "CODEX",
      host: "NATIVE",
      interaction: "HEADLESS",
      assurance: "ADVISORY",
      instructions: "Review",
      maximumRuntimeSeconds: 600,
      deadlineAt: 1_000,
      dispatchPermit: "permit_secret",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_DEADLINE_EXPIRED" } });
    expect({ permits, starts }).toEqual({ permits: 0, starts: 0 });
  });

  test("releases retryable permit reservations and records failures after permit consumption", async () => {
    let now = 900;
    let reserved = false;
    let permits = 0;
    let starts = 0;
    const failures: string[] = [];
    const processes = {
      reserve: () => {
        if (reserved) {
          return {
            ok: true as const,
            value: { reservationId: "reservation_1", disposition: "RESUME" as const },
          };
        }
        reserved = true;
        return {
          ok: true as const,
          value: { reservationId: "reservation_1", disposition: "NEW" as const },
        };
      },
      release: () => {
        reserved = false;
        return { ok: true as const, value: undefined };
      },
      recordFailed: (_reservation: unknown, code: string) => {
        failures.push(code);
        return { ok: true as const, value: undefined };
      },
      markStarting: () => ({ ok: true as const, value: undefined }),
      recordStarted: () => ({ ok: true as const, value: undefined }),
    };
    const supervisor = createRunnerSupervisor({
      profiles: { resolve: () => ({ ok: true, value: profile }) },
      processes,
      worktrees: { resolveRunWorktree: async () => ({ ok: true, value: { id: "worktree_1" } }) },
      environment: { build: () => ({ ok: true, value: {} }), validate: () => true },
      enforcement: {
        assurance: "ADVISORY",
        activate: async () => ({ ok: true, value: { sessionId: "enforcement_1" } }),
        inspect: async () => ({ ok: true, value: { state: "ACTIVE", assurance: "ADVISORY" } }),
        revoke: async () => ({ ok: true, value: undefined }),
      },
      permits: {
        consume: async () => {
          permits += 1;
          if (permits === 1) {
            return {
              ok: false as const,
              error: { code: "PERMIT_TEMPORARY", message: "Retry.", retry: "REFRESH" as const },
            };
          }
          now = 1_000;
          return { ok: true as const, value: { consumed: true as const } };
        },
      },
      adapters: { CODEX: createCodexExecutionAdapter() },
      hosts: {
        NATIVE: createNativeExecutionHost({
          start: async () => {
            starts += 1;
            return { opaqueProcessId: "process_1" };
          },
          cancel: async () => true,
          inspect: async () => "RUNNING",
          attach: async () => ({ localAttachmentId: "attachment_1" }),
        }),
      },
      clock: () => now,
      output: outputTransport(),
    });
    const request = {
      runId: "run_1",
      attemptId: "attempt_1",
      assignmentDigest: "b".repeat(64),
      worktreeKey: "worktree_1",
      profileVersionId: "profile_1",
      expectedProfileFingerprint: profile.fingerprint,
      runtime: "CODEX" as const,
      host: "NATIVE" as const,
      interaction: "HEADLESS" as const,
      assurance: "ADVISORY" as const,
      instructions: "Review",
      maximumRuntimeSeconds: 600,
      deadlineAt: 1_000,
      dispatchPermit: "permit_secret",
    };
    expect(await supervisor.launch(request)).toMatchObject({
      ok: false,
      error: { code: "PERMIT_TEMPORARY" },
    });
    now = 900;
    expect(await supervisor.launch(request)).toMatchObject({
      ok: false,
      error: { code: "EXECUTION_DEADLINE_EXPIRED" },
    });
    expect({ permits, starts, failures }).toEqual({
      permits: 2,
      starts: 0,
      failures: ["EXECUTION_DEADLINE_EXPIRED"],
    });
  });

  test("uses the environment builder allowlist for profile credential bindings", async () => {
    let starts = 0;
    const environment = createRunnerEnvironmentBuilder({
      base: { HOME: "/safe/home", PATH: "/usr/bin:/bin" },
      allowedNames: ["ANTHROPIC_API_KEY"],
      credentials: { resolve: () => "local-secret" },
    });
    const supervisor = createRunnerSupervisor({
      profiles: {
        resolve: () => ({
          ok: true,
          value: {
            ...profile,
            environment: [
              {
                name: "ANTHROPIC_API_KEY",
                source: "OS_CREDENTIAL",
                reference: "anthropic.default",
              },
            ],
          },
        }),
      },
      processes: {
        reserve: () => ({
          ok: true,
          value: { reservationId: "reservation_1", disposition: "NEW" },
        }),
        release: () => ({ ok: true, value: undefined }),
        recordFailed: () => ({ ok: true, value: undefined }),
        markStarting: () => ({ ok: true, value: undefined }),
        recordStarted: () => ({ ok: true, value: undefined }),
      },
      worktrees: { resolveRunWorktree: async () => ({ ok: true, value: { id: "worktree_1" } }) },
      environment,
      enforcement: {
        assurance: "ADVISORY",
        activate: async () => ({ ok: true, value: { sessionId: "enforcement_1" } }),
        inspect: async () => ({ ok: true, value: { state: "ACTIVE", assurance: "ADVISORY" } }),
        revoke: async () => ({ ok: true, value: undefined }),
      },
      permits: { consume: async () => ({ ok: true, value: { consumed: true } }) },
      adapters: { CODEX: createCodexExecutionAdapter() },
      hosts: {
        NATIVE: createNativeExecutionHost({
          start: async (input) => {
            starts += 1;
            expect(input.environment.ANTHROPIC_API_KEY).toBe("local-secret");
            return { opaqueProcessId: "process_1" };
          },
          cancel: async () => true,
          inspect: async () => "RUNNING",
          attach: async () => ({ localAttachmentId: "attachment_1" }),
        }),
      },
      clock: () => 1_000,
      output: outputTransport(),
    });
    expect(
      await supervisor.launch({
        runId: "run_1",
        attemptId: "attempt_1",
        assignmentDigest: "b".repeat(64),
        worktreeKey: "worktree_1",
        profileVersionId: "profile_1",
        expectedProfileFingerprint: profile.fingerprint,
        runtime: "CODEX",
        host: "NATIVE",
        interaction: "HEADLESS",
        assurance: "ADVISORY",
        instructions: "Review",
        maximumRuntimeSeconds: 600,
        deadlineAt: 2_000,
        dispatchPermit: "permit_secret",
      }),
    ).toMatchObject({ ok: true });
    expect(starts).toBe(1);
  });
});
