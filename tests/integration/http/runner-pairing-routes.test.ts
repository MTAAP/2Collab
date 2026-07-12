import { expect, test } from "bun:test";
import { createRunnerPairingRoutes } from "../../../src/server/adapters/http/routes/runner-pairing.ts";

const device = {
  kind: "VERIFIED_DEVICE" as const,
  memberId: "member_1" as never,
  memberAuthorityEpoch: 1,
  deviceFamilyId: "family_1",
  deviceId: "device_1",
  senderKeyThumbprint: "thumb_1",
  expiresAt: 2_000,
};

test("runner pairing routes preserve device and browser authority boundaries", async () => {
  const calls: unknown[] = [];
  const app = createRunnerPairingRoutes({
    registry: {
      beginPairing: async (value: unknown) => {
        calls.push(value);
        return {
          ok: true,
          value: { pairingId: "pair_1", pairingSecret: "s".repeat(32), expiresAt: 2_000 },
        };
      },
      confirmPairing: async (value: unknown) => {
        calls.push(value);
        return { ok: true, value: { pairingId: "pair_1", confirmedAt: 1_000 } };
      },
      consumePairing: async (value: unknown) => {
        calls.push(value);
        return {
          ok: true,
          value: {
            runnerId: "runner_1",
            runnerEpoch: 1,
            ownerMemberId: "member_1",
            runnerCredential: "c".repeat(32),
            keyThumbprint: "key_1",
          },
        };
      },
    },
    runnerAuthentication: {
      exchangeCredential: async () => ({
        ok: true,
        value: { accessToken: "a".repeat(32), nonce: "n".repeat(32), expiresAt: 2_000 },
      }),
    },
    authentication: {
      authenticateBrowser: async () => ({
        ok: true,
        value: {
          kind: "MEMBER",
          memberId: "member_1",
          sessionId: "session_1",
          sessionProof: "proof",
        } as never,
      }),
      authenticateDevice: async () => ({
        ok: true,
        value: {
          kind: "MEMBER",
          memberId: "member_1",
          sessionId: "family_1",
          sessionProof: "proof",
        } as never,
      }),
      authenticateRunnerDevice: async () => ({ ok: true, value: device }),
      verifyBrowserMutation: () => true,
    },
  } as never);

  expect(
    (
      await app.request("/begin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "begin_1" }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request("/pair_1/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "confirm_1" }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request("/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "consume_1",
          pairingSecret: "s".repeat(32),
          keyId: "key_1",
          keyProof: "proof",
        }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request("/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runnerCredential: "c".repeat(32), keyProof: "proof" }),
      })
    ).status,
  ).toBe(200);
  expect(calls).toEqual([
    { idempotencyKey: "begin_1", principal: device },
    {
      idempotencyKey: "confirm_1",
      actor: {
        kind: "MEMBER",
        memberId: "member_1",
        sessionId: "session_1",
        sessionProof: "proof",
      },
      pairingId: "pair_1",
    },
    {
      idempotencyKey: "consume_1",
      pairingSecret: "s".repeat(32),
      keyId: "key_1",
      keyProof: "proof",
    },
  ]);
});

test("runner pairing begin rejects an ordinary member projection", async () => {
  const app = createRunnerPairingRoutes({
    registry: {} as never,
    authentication: {
      authenticateBrowser: async () => ({
        ok: false,
        error: { code: "SESSION_REQUIRED", message: "required", retry: "NEVER" },
      }),
      authenticateDevice: async () => ({
        ok: false,
        error: { code: "DEVICE_AUTHENTICATION_REQUIRED", message: "required", retry: "NEVER" },
      }),
      verifyBrowserMutation: () => false,
    },
  });
  expect(
    (
      await app.request("/begin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "begin_1" }),
      })
    ).status,
  ).toBe(401);
});
