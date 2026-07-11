import { describe, expect, test } from "bun:test";
import { createRunnerFixture } from "./runner-fixture.ts";

describe("runner pairing", () => {
  test("binds device, confirming member, and new runner key while persisting hashes only", async () => {
    const fixture = createRunnerFixture();
    try {
      const begun = await fixture.registry.beginPairing({ principal: fixture.device("member_a") });
      expect(begun.ok).toBeTrue();
      if (!begun.ok) return;
      const wrongMember = await fixture.registry.confirmPairing({
        actor: fixture.actor("member_b"),
        pairingId: begun.value.pairingId,
      });
      expect(wrongMember.ok).toBeFalse();
      if (!wrongMember.ok) expect(wrongMember.error.code).toBe("RUNNER_PAIRING_MEMBER_MISMATCH");
      expect(
        await fixture.registry.confirmPairing({
          actor: fixture.actor("member_a"),
          pairingId: begun.value.pairingId,
        }),
      ).toMatchObject({ ok: true });
      const consumed = await fixture.registry.consumePairing({
        pairingSecret: begun.value.pairingSecret,
        keyId: "key_a",
        keyProof: "new:key_a",
      });
      expect(consumed.ok).toBeTrue();
      const storage = JSON.stringify(
        fixture.database.query<Record<string, unknown>, []>("SELECT * FROM runner_pairings").all(),
      );
      expect(storage).not.toContain(begun.value.pairingSecret);
      if (consumed.ok) expect(storage).not.toContain(consumed.value.runnerCredential);
      const replay = await fixture.registry.consumePairing({
        pairingSecret: begun.value.pairingSecret,
        keyId: "key_a",
        keyProof: "new:key_a",
      });
      expect(replay.ok).toBeFalse();
      if (!replay.ok) expect(replay.error.code).toBe("RUNNER_PAIRING_CONSUMED");
    } finally {
      fixture.close();
    }
  });

  test("rejects forged device principals and the exact ten-minute expiry boundary", async () => {
    const fixture = createRunnerFixture();
    try {
      const forged = await fixture.registry.beginPairing({
        principal: {
          ...fixture.device("member_a"),
          deviceFamilyId: "missing_family",
        } as never,
      });
      expect(forged.ok).toBeFalse();
      if (!forged.ok) expect(forged.error.code).toBe("RUNNER_PAIRING_DEVICE_INVALID");

      const begun = await fixture.registry.beginPairing({ principal: fixture.device("member_a") });
      if (!begun.ok) throw new Error(begun.error.code);
      await fixture.registry.confirmPairing({
        actor: fixture.actor("member_a"),
        pairingId: begun.value.pairingId,
      });
      fixture.setNow(begun.value.expiresAt);
      const expired = await fixture.registry.consumePairing({
        pairingSecret: begun.value.pairingSecret,
        keyId: "expired_key",
        keyProof: "new:expired_key",
      });
      expect(expired.ok).toBeFalse();
      if (!expired.ok) expect(expired.error.code).toBe("RUNNER_PAIRING_INVALID");
    } finally {
      fixture.close();
    }
  });
});
