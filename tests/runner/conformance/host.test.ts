import { describe, expect, test } from "bun:test";
import { createNativeExecutionHost } from "../../../src/runner/adapters/host/native.ts";
import { createOrcaExecutionHost } from "../../../src/runner/adapters/host/orca.ts";
import type { SupervisorLaunch } from "../../../src/runner/adapters/host/contract.ts";

function launch(
  interaction: "HEADLESS" | "INTERACTIVE",
  assurance: "ADVISORY" | "ENFORCED" = "ADVISORY",
): SupervisorLaunch {
  return {
    attemptId: "attempt_1",
    worktree: { id: "worktree_1" },
    invocation: {
      argv: ["/opt/collab/bin/codex", "exec"],
      prompt: { transport: "STDIN", text: "Review" },
    },
    environment: { PATH: "/usr/bin:/bin", HOME: "/Users/test" },
    interaction,
    assurance,
    deadlineAt: 2_000,
    ...(interaction === "HEADLESS" ? { headlessOutput: async () => undefined } : {}),
  };
}

describe("execution host conformance", () => {
  for (const fixture of [
    {
      name: "Native",
      host: createNativeExecutionHost({
        start: async (input) => ({ opaqueProcessId: `native:${input.interaction}` }),
        cancel: async () => true,
        inspect: async () => "RUNNING",
        attach: async () => ({ localAttachmentId: "native_attachment" }),
      }),
    },
    {
      name: "Orca",
      host: createOrcaExecutionHost({
        start: async (input) => ({ opaqueProcessId: `orca:${input.interaction}` }),
        cancel: async () => true,
        inspect: async () => "RUNNING",
        attach: async () => ({ localAttachmentId: "orca_attachment" }),
      }),
    },
  ]) {
    for (const interaction of ["HEADLESS", "INTERACTIVE"] as const) {
      test(`${fixture.name} ${interaction} starts only prepared advisory execution`, async () => {
        expect(await fixture.host.start(launch(interaction))).toMatchObject({
          ok: true,
          value: { interaction, assurance: "ADVISORY" },
        });
      });
    }

    test(`${fixture.name} rejects ENFORCED before invoking the trusted host`, async () => {
      expect(await fixture.host.start(launch("HEADLESS", "ENFORCED"))).toMatchObject({
        ok: false,
        error: { code: "ASSURANCE_UNAVAILABLE" },
      });
    });
  }
});
