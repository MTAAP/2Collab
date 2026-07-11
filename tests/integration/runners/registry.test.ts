import { expect, test } from "bun:test";
import { createRunnerFixture } from "./runner-fixture.ts";

test("runner registry preserves ownership and returns stale exposure facts", async () => {
  const fixture = createRunnerFixture();
  try {
    const runner = await fixture.pair("member_a");
    const denied = await fixture.registry.registerMapping({
      actor: fixture.actor("member_b"),
      runnerId: runner.runnerId,
      projectId: "project_1" as never,
      localMappingId: "mapping_private",
    });
    expect(denied.ok).toBeFalse();
    if (!denied.ok) expect(denied.error.code).toBe("RUNNER_OWNER_REQUIRED");

    const exposure = await fixture.expose(runner.runnerId);
    const current = await fixture.registry.inspectEligibility({
      actor: fixture.actor("member_b"),
      ...exposure,
    });
    expect(current.ok && current.value.disposition).toBe("CURRENT");

    fixture.policyFactsStore.replaceForAuthority({
      runnerId: runner.runnerId,
      expectedPolicyRevision: 2,
      audience: "TEAM",
      maximumConcurrentAttempts: 2,
    });
    const stale = await fixture.registry.inspectEligibility({
      actor: fixture.actor("member_b"),
      ...exposure,
    });
    expect(stale.ok && stale.value.disposition).toBe("STALE");
  } finally {
    fixture.close();
  }
});
