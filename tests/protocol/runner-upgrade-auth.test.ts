import { describe, expect, test } from "bun:test";
import { createRunnerUpgradeAuthenticator } from "../../src/server/adapters/wss/upgrade-auth.ts";
import type { VerifiedRunnerPrincipal } from "../../src/shared/contracts/actors.ts";

const principal = {
  kind: "VERIFIED_RUNNER",
  runnerId: "runner_1",
  runnerEpoch: 1,
  ownerMemberId: "member_1",
  keyThumbprint: "thumbprint_1",
  accessExpiresAt: 2_000,
} as unknown as VerifiedRunnerPrincipal;

describe("runner pre-upgrade authentication", () => {
  test("authenticates exact secure path with DPoP fields before upgrade", async () => {
    const seen: unknown[] = [];
    const authenticate = createRunnerUpgradeAuthenticator({
      authority: {
        async authenticateUpgrade(input) {
          seen.push(input);
          return { ok: true, value: principal };
        },
      },
    });
    const result = await authenticate(
      new Request("https://collab.test/runner/v1", {
        headers: {
          authorization: `DPoP ${"a".repeat(48)}`,
          dpop: "signed-proof",
          "dpop-nonce": "nonce_1",
        },
      }),
      { secureTransport: true },
    );
    expect(result).toEqual({ ok: true, value: principal });
    expect(seen).toEqual([
      {
        accessToken: "a".repeat(48),
        proof: "signed-proof",
        nonce: "nonce_1",
        method: "GET",
        uri: "https://collab.test/runner/v1",
      },
    ]);
  });

  test("fails closed before authority for insecure, misplaced, or malformed credentials", async () => {
    let calls = 0;
    const authenticate = createRunnerUpgradeAuthenticator({
      authority: {
        async authenticateUpgrade() {
          calls += 1;
          return { ok: true, value: principal };
        },
      },
    });
    const cases: Array<readonly [Request, boolean]> = [
      [new Request(`https://collab.test/runner/v1?access_token=${"a".repeat(48)}`), true],
      [new Request("https://collab.test/runner/v1", { headers: { cookie: "token=secret" } }), true],
      [
        new Request("https://collab.test/runner/v1", {
          headers: { "sec-websocket-protocol": `token.${"a".repeat(48)}` },
        }),
        true,
      ],
      [
        new Request("https://collab.test/runner/v1", {
          headers: { authorization: `Bearer ${"a".repeat(48)}`, dpop: "proof", "dpop-nonce": "n" },
        }),
        true,
      ],
      [
        new Request("https://collab.test/runner/v1", {
          headers: { authorization: `DPoP ${"a".repeat(48)}`, dpop: "proof", "dpop-nonce": "n" },
        }),
        false,
      ],
      [
        new Request("https://collab.test/not-runner", {
          headers: { authorization: `DPoP ${"a".repeat(48)}`, dpop: "proof", "dpop-nonce": "n" },
        }),
        true,
      ],
    ];
    for (const [request, secureTransport] of cases) {
      const result = await authenticate(request, { secureTransport });
      expect(result.ok).toBeFalse();
      if (!result.ok) expect(result.error.code).toBe("RUNNER_UPGRADE_UNAUTHORIZED");
    }
    expect(calls).toBe(0);
  });
});
