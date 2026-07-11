import { describe, expect, test } from "bun:test";
import { createRunnerSupervisor } from "../../src/runner/supervisor.ts";
import { createCodexExecutionAdapter } from "../../src/runner/adapters/runtime/codex.ts";
import { createNativeExecutionHost } from "../../src/runner/adapters/host/native.ts";

const profile = {
  adapter: "CODEX",
  executable: "/opt/collab/bin/codex",
  fixedArguments: ["--model", "gpt-5"],
  promptTransport: { headless: "STDIN", interactive: "TERMINAL_INPUT" },
  supportedInteractions: ["HEADLESS", "INTERACTIVE"],
  fingerprint: "a".repeat(64),
} as const;

describe("runner supervisor", () => {
  test("consumes a permit immediately before one reserved process start", async () => {
    const order: string[] = [];
    let starts = 0;
    const host = createNativeExecutionHost({
      async start(input) {
        order.push("start");
        starts += 1;
        expect(input.worktree.id).toBe("worktree_1");
        expect(input.environment).toEqual({ HOME: "/safe/home", PATH: "/usr/bin:/bin" });
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
      },
      enforcement: {
        assurance: "ADVISORY",
        async activate() {
          order.push("enforcement");
          return { ok: true, value: { sessionId: "enforcement_1" } };
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
      "start",
      "record",
    ]);
    expect(starts).toBe(1);
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
        recordStarted: () => ({ ok: true, value: undefined }),
      },
      worktrees: { resolveRunWorktree: async () => ({ ok: true, value: { id: "worktree_1" } }) },
      environment: { build: () => ({ ok: true, value: {} }) },
      enforcement: {
        assurance: "ADVISORY",
        activate: async () => ({ ok: true, value: { sessionId: "enforcement_1" } }),
        revoke: async () => ({ ok: true, value: undefined }),
      },
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
});
