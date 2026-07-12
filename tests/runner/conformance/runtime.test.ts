import { describe, expect, test } from "bun:test";
import { createClaudeExecutionAdapter } from "../../../src/runner/adapters/runtime/claude.ts";
import { createCodexExecutionAdapter } from "../../../src/runner/adapters/runtime/codex.ts";
import type {
  CustomLaunchProfile,
  PreparedExecutionRequest,
} from "../../../src/runner/adapters/runtime/contract.ts";

const request = (profile: CustomLaunchProfile): PreparedExecutionRequest => ({
  profile,
  profileVersionId: "profile_version_1",
  expectedFingerprint: profile.fingerprint,
  interaction: "HEADLESS",
  instructions: "Review `$HOME`; do not execute $(touch /tmp/pwned).\nReturn evidence.",
  maximumRuntimeSeconds: 600,
});

describe("runtime adapter conformance", () => {
  const fixtures = [
    {
      name: "Claude",
      adapter: createClaudeExecutionAdapter(),
      profile: {
        adapter: "CLAUDE",
        executable: "/opt/collab/bin/claude",
        fixedArguments: ["--model", "sonnet"],
        promptTransport: { headless: "STDIN", interactive: "TERMINAL_INPUT" },
        supportedInteractions: ["HEADLESS", "INTERACTIVE"],
        fingerprint: "a".repeat(64),
      } as const,
    },
    {
      name: "Codex",
      adapter: createCodexExecutionAdapter(),
      profile: {
        adapter: "CODEX",
        executable: "/opt/collab/bin/codex",
        fixedArguments: ["--model", "gpt-5"],
        promptTransport: { headless: "STDIN", interactive: "TERMINAL_INPUT" },
        supportedInteractions: ["HEADLESS", "INTERACTIVE"],
        fingerprint: "b".repeat(64),
      } as const,
    },
  ];

  for (const fixture of fixtures) {
    test(`${fixture.name} prepares an argv without starting a process or exposing environment`, async () => {
      const result = await fixture.adapter.prepare(request(fixture.profile));
      expect(result.ok).toBeTrue();
      if (!result.ok) return;
      expect(result.value.invocation.argv[0]).toBe(fixture.profile.executable);
      expect(result.value.invocation.argv).not.toContain(request(fixture.profile).instructions);
      expect(result.value.prompt).toEqual({
        transport: "STDIN",
        text: request(fixture.profile).instructions,
      });
      expect(result.value).not.toHaveProperty("environment");
      expect(result.value.invocation).not.toHaveProperty("shell");
    });

    test(`${fixture.name} rejects mismatched profiles, reserved flags, and unsupported interaction`, async () => {
      expect(
        await fixture.adapter.prepare({
          ...request(fixture.profile),
          expectedFingerprint: "c".repeat(64),
        }),
      ).toMatchObject({ ok: false, error: { code: "PROFILE_VERSION_MISMATCH" } });
      expect(
        await fixture.adapter.prepare({
          ...request(fixture.profile),
          profile: { ...fixture.profile, fixedArguments: ["--cwd", "/tmp/escape"] },
        }),
      ).toMatchObject({ ok: false, error: { code: "PROFILE_POLICY_DENIED" } });
      expect(
        await fixture.adapter.prepare({
          ...request(fixture.profile),
          interaction: "INTERACTIVE",
          profile: { ...fixture.profile, supportedInteractions: ["HEADLESS"] },
        }),
      ).toMatchObject({ ok: false, error: { code: "CAPABILITY_UNSUPPORTED" } });
    });
  }

  test("Claude and Codex prepare argv without starting a process", async () => {
    for (const fixture of fixtures) {
      const result = await fixture.adapter.prepare(request(fixture.profile));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.invocation.argv[0]).toBe(fixture.profile.executable);
    }
  });
});
