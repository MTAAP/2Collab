import { describe, expect, test } from "bun:test";
import { createRunnerFixture } from "./runner-fixture.ts";

describe("runner mappings and profiles", () => {
  test("keeps one active version and rejects local execution details", async () => {
    const fixture = createRunnerFixture();
    try {
      const paired = await fixture.pair("member_a");
      const mapping = await fixture.registry.registerMapping({
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        projectId: "project_1" as never,
        localMappingId: "opaque_1",
      });
      expect(mapping).toMatchObject({ ok: true, value: { revision: 1 } });
      const replaced = await fixture.registry.replaceMapping({
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        projectId: "project_1" as never,
        expectedRevision: 1,
        localMappingId: "opaque_2",
      });
      expect(replaced).toMatchObject({ ok: true, value: { revision: 2 } });
      const unsafe = await fixture.registry.advertiseProfile({
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        displayName: "Unsafe",
        adapter: "CODEX",
        hosts: ["NATIVE"],
        interactions: ["HEADLESS"],
        riskSummary: "Risk",
        fingerprint: "a".repeat(64),
        command: "/usr/local/bin/codex",
      } as never);
      expect(unsafe.ok).toBeFalse();
      if (!unsafe.ok) expect(unsafe.error.code).toBe("RUNNER_PROFILE_INVALID");
    } finally {
      fixture.close();
    }
  });
});
