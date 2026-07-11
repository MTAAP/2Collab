import { describe, expect, test } from "bun:test";
import { createRunnerFixture } from "./runner-fixture.ts";

describe("runner pairing concurrency", () => {
  test("has exactly one consume winner", async () => {
    const fixture = createRunnerFixture();
    try {
      const begun = await fixture.registry.beginPairing({ principal: fixture.device("member_a") });
      if (!begun.ok) throw new Error(begun.error.code);
      await fixture.registry.confirmPairing({
        actor: fixture.actor("member_a"),
        pairingId: begun.value.pairingId,
      });
      const results = await Promise.all([
        fixture.registry.consumePairing({
          pairingSecret: begun.value.pairingSecret,
          keyId: "key_a",
          keyProof: "new:key_a",
        }),
        fixture.registry.consumePairing({
          pairingSecret: begun.value.pairingSecret,
          keyId: "key_a",
          keyProof: "new:key_a",
        }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });
});
