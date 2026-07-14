import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createDeviceAuthority } from "../../../src/server/modules/identity/devices.ts";
import { createRunnerFixture } from "./runner-fixture.ts";

describe("runner pairing", () => {
  test("accepts the real verified device principal until its exact access expiry", async () => {
    const fixture = createRunnerFixture();
    try {
      const accessToken = `device_access_${"a".repeat(40)}`;
      const accessHash = createHash("sha256").update(accessToken).digest();
      fixture.database
        .query(
          `INSERT INTO device_access_tokens(
             id, family_id, access_hash, sender_key_thumbprint, revision, created_at, expires_at
           ) VALUES ('device_access_pairing', 'family_member_a', ?, 'device_thumb_member_a', 1, ?, ?)`,
        )
        .run(accessHash, fixture.now(), fixture.now() + 600);
      const authority = createDeviceAuthority({
        database: fixture.database,
        clock: fixture.now,
        id: (prefix) => `${prefix}_pairing`,
        digest: async (value) => createHash("sha256").update(value).digest(),
      });
      const verified = await authority.verifyAccess({
        accessToken,
        senderKeyThumbprint: "device_thumb_member_a",
      });
      if (!verified.ok) throw new Error(verified.error.code);

      expect(
        await fixture.registry.beginPairing({
          idempotencyKey: "real_device_begin",
          principal: verified.value,
        }),
      ).toMatchObject({
        ok: true,
      });
      fixture.setNow(verified.value.expiresAt);
      const expired = await fixture.registry.beginPairing({
        idempotencyKey: "expired_device_begin",
        principal: verified.value,
      });
      expect(expired.ok).toBeFalse();
      if (!expired.ok) expect(expired.error.code).toBe("RUNNER_PAIRING_INVALID");
    } finally {
      fixture.close();
    }
  });

  test("binds device, confirming member, and new runner key while persisting hashes only", async () => {
    const fixture = createRunnerFixture();
    try {
      const begun = await fixture.registry.beginPairing({
        idempotencyKey: "pairing_begin",
        principal: fixture.device("member_a"),
      });
      expect(begun.ok).toBeTrue();
      if (!begun.ok) return;
      const begunReplay = await fixture.registry.beginPairing({
        idempotencyKey: "pairing_begin",
        principal: fixture.device("member_a"),
      });
      expect(begunReplay.ok).toBeFalse();
      if (!begunReplay.ok) expect(begunReplay.error.code).toBe("SECRET_ALREADY_ISSUED");
      const wrongMember = await fixture.registry.confirmPairing({
        idempotencyKey: "pairing_wrong_confirm",
        actor: fixture.actor("member_b"),
        pairingId: begun.value.pairingId,
      });
      expect(wrongMember.ok).toBeFalse();
      if (!wrongMember.ok) expect(wrongMember.error.code).toBe("RUNNER_PAIRING_MEMBER_MISMATCH");
      expect(
        await fixture.registry.confirmPairing({
          idempotencyKey: "pairing_confirm",
          actor: fixture.actor("member_a"),
          pairingId: begun.value.pairingId,
        }),
      ).toMatchObject({ ok: true });
      const consumed = await fixture.registry.consumePairing({
        idempotencyKey: "pairing_consume",
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
      const secretReplay = await fixture.registry.consumePairing({
        idempotencyKey: "pairing_consume",
        pairingSecret: begun.value.pairingSecret,
        keyId: "key_a",
        keyProof: "new:key_a",
      });
      expect(secretReplay.ok).toBeFalse();
      if (!secretReplay.ok) expect(secretReplay.error.code).toBe("SECRET_ALREADY_ISSUED");
      const replay = await fixture.registry.consumePairing({
        idempotencyKey: "pairing_consume_replay",
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
        idempotencyKey: "forged_pairing",
        principal: {
          ...fixture.device("member_a"),
          deviceFamilyId: "missing_family",
        } as never,
      });
      expect(forged.ok).toBeFalse();
      if (!forged.ok) expect(forged.error.code).toBe("RUNNER_PAIRING_DEVICE_INVALID");

      const begun = await fixture.registry.beginPairing({
        idempotencyKey: "expiring_pairing",
        principal: fixture.device("member_a"),
      });
      if (!begun.ok) throw new Error(begun.error.code);
      await fixture.registry.confirmPairing({
        idempotencyKey: "expiring_pairing_confirm",
        actor: fixture.actor("member_a"),
        pairingId: begun.value.pairingId,
      });
      fixture.setNow(begun.value.expiresAt);
      const expired = await fixture.registry.consumePairing({
        idempotencyKey: "expiring_pairing_consume",
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
