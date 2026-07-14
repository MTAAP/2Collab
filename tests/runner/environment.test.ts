import { describe, expect, test } from "bun:test";
import { createRunnerEnvironmentBuilder } from "../../src/runner/environment.ts";
import type { CustomLaunchProfile } from "../../src/runner/execution-contract.ts";

const base: CustomLaunchProfile = {
  adapter: "CODEX",
  executable: "/opt/collab/bin/codex",
  fixedArguments: [],
  promptTransport: { headless: "STDIN", interactive: "TERMINAL_INPUT" },
  supportedInteractions: ["HEADLESS"],
  fingerprint: "a".repeat(64),
};

describe("runner environment builder", () => {
  test("constructs only an explicit minimal environment and resolves local credential references", () => {
    const builder = createRunnerEnvironmentBuilder({
      base: { HOME: "/safe/home", PATH: "/usr/bin:/bin" },
      allowedNames: ["LANG", "OPENAI_API_KEY"],
      credentials: {
        resolve(reference) {
          return reference === "openai.default" ? "local-secret" : undefined;
        },
      },
    });
    expect(
      builder.build({
        ...base,
        environment: [
          { name: "LANG", source: "LITERAL", value: "en_US.UTF-8" },
          { name: "OPENAI_API_KEY", source: "OS_CREDENTIAL", reference: "openai.default" },
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        HOME: "/safe/home",
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: "local-secret",
      },
    });
  });

  test("denies protected overrides, duplicates, missing credentials, and unsafe values without echoing them", () => {
    const builder = createRunnerEnvironmentBuilder({
      base: { HOME: "/safe/home", PATH: "/usr/bin:/bin" },
      allowedNames: ["LANG", "OPENAI_API_KEY"],
      credentials: { resolve: () => undefined },
    });
    for (const environment of [
      [{ name: "PATH", source: "LITERAL", value: "/attacker" }],
      [
        { name: "LANG", source: "LITERAL", value: "a" },
        { name: "LANG", source: "LITERAL", value: "b" },
      ],
      [{ name: "OPENAI_API_KEY", source: "OS_CREDENTIAL", reference: "missing.secret" }],
      [{ name: "LANG", source: "LITERAL", value: "secret\nINJECTED=value" }],
    ] as const) {
      const result = builder.build({ ...base, environment });
      expect(result).toMatchObject({ ok: false, error: { code: "ENVIRONMENT_POLICY_DENIED" } });
      expect(JSON.stringify(result)).not.toContain("attacker");
      expect(JSON.stringify(result)).not.toContain("missing.secret");
      expect(JSON.stringify(result)).not.toContain("INJECTED");
    }
  });
});
