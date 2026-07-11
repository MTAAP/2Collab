import { describe, expect, test } from "bun:test";
import { createRunnerFixture } from "./runner-fixture.ts";

describe("runner revocation", () => {
  test("advances epoch first and invalidates credentials, mappings, acknowledgements, and exposures", async () => {
    const fixture = createRunnerFixture();
    try {
      const paired = await fixture.pair("member_a");
      await fixture.expose(paired.runnerId);
      const revoked = await fixture.registry.revoke({
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        expectedRunnerEpoch: 1,
      });
      expect(revoked).toMatchObject({
        ok: true,
        value: { runnerEpoch: 2, disposition: "REVOKED" },
      });
      expect(fixture.registry.inspectLease(paired.runnerId).state).toBe("REVOKED");
      const auth = await fixture.authentication.exchangeCredential({
        runnerCredential: paired.runnerCredential,
        keyProof: `possession:${paired.keyThumbprint}`,
      });
      expect(auth.ok).toBeFalse();
    } finally {
      fixture.close();
    }
  });
});
