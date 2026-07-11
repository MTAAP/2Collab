import { describe, expect, test } from "bun:test";
import { createRunnerFixture } from "./runner-fixture.ts";

describe("runner authentication", () => {
  test("requires the distinct credential, current epoch, and bound runner-key proof", async () => {
    const fixture = createRunnerFixture();
    try {
      const paired = await fixture.pair("member_a");
      const deviceToken = await fixture.authentication.exchangeCredential({
        runnerCredential: "device_access_not_a_runner_credential",
        keyProof: `possession:${paired.keyThumbprint}`,
      });
      expect(deviceToken.ok).toBeFalse();
      const exchanged = await fixture.authentication.exchangeCredential({
        runnerCredential: paired.runnerCredential,
        keyProof: `possession:${paired.keyThumbprint}`,
      });
      expect(exchanged.ok).toBeTrue();
      if (!exchanged.ok) return;
      const principal = await fixture.authentication.authenticateAccess({
        accessToken: exchanged.value.accessToken,
        proof: "dpop:jti_auth_1",
        nonce: exchanged.value.nonce,
        method: "GET",
        uri: "https://collab.test/runner/v1",
      });
      expect(principal).toMatchObject({
        ok: true,
        value: { kind: "VERIFIED_RUNNER", runnerId: paired.runnerId, runnerEpoch: 1 },
      });

      for (const changed of [
        { method: "POST" },
        { uri: "https://collab.test/not-runner" },
        { nonce: "wrong-nonce-with-at-least-thirty-two-bytes" },
        { accessToken: "wrong-token-with-at-least-thirty-two-bytes" },
      ]) {
        const result = await fixture.authentication.authenticateAccess({
          accessToken: exchanged.value.accessToken,
          proof: `dpop:jti_wrong_${Object.keys(changed)[0]}`,
          nonce: exchanged.value.nonce,
          method: "GET",
          uri: "https://collab.test/runner/v1",
          ...changed,
        } as never);
        expect(result.ok).toBeFalse();
      }
      const replay = await fixture.authentication.authenticateAccess({
        accessToken: exchanged.value.accessToken,
        proof: "dpop:jti_auth_1",
        nonce: exchanged.value.nonce,
        method: "GET",
        uri: "https://collab.test/runner/v1",
      });
      expect(replay.ok).toBeFalse();
      if (!replay.ok) expect(replay.error.code).toBe("RUNNER_DPOP_REPLAY");
      expect(
        fixture.database
          .query<{ count: number }, []>("SELECT count(*) AS count FROM dpop_replays")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      fixture.close();
    }
  });
});
