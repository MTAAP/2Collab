import { describe, expect, test } from "bun:test";
import { createRunnerFixture } from "./runner-fixture.ts";

describe("runner ownership and policy", () => {
  test("keeps policy replacement private to committed authority facts and uses CAS revisions", async () => {
    const fixture = createRunnerFixture();
    try {
      const paired = await fixture.pair("member_a");
      expect(
        fixture.policyFactsStore.replaceForAuthority({
          runnerId: paired.runnerId,
          expectedPolicyRevision: 1,
          audience: "TEAM",
          maximumConcurrentAttempts: 2,
        }),
      ).toEqual({
        runnerId: paired.runnerId,
        audience: "TEAM",
        maximumConcurrentAttempts: 2,
        policyRevision: 2,
      });
      expect(() =>
        fixture.policyFactsStore.replaceForAuthority({
          runnerId: paired.runnerId,
          expectedPolicyRevision: 1,
          audience: "OWNER_ONLY",
          maximumConcurrentAttempts: 1,
        }),
      ).toThrow("RUNNER_POLICY_STALE");
      expect("replacePolicy" in fixture.registry).toBeFalse();
      expect(() =>
        fixture.policyFactsStore.replaceForAuthority({
          runnerId: paired.runnerId,
          expectedPolicyRevision: 2,
          audience: "TEAM",
          maximumConcurrentAttempts: 33,
        }),
      ).toThrow("RUNNER_POLICY_INVALID");
    } finally {
      fixture.close();
    }
  });
});
