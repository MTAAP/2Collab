import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../../src/server/db/connection.ts";
import { migrate } from "../../../src/server/db/migrate.ts";
import { verifyCsrf } from "../../../src/server/modules/identity/csrf.ts";
import { createDeviceAuthority } from "../../../src/server/modules/identity/devices.ts";
import {
  createDpopVerifier,
  createSessionAuthority,
} from "../../../src/server/modules/identity/sessions.ts";

function fixture() {
  const database = openDatabase(":memory:");
  migrate(database);
  database.exec(`
    INSERT INTO deployments(id, singleton, team_id, revision, created_at)
      VALUES ('deployment_1', 1, 'team_1', 1, 0);
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
      VALUES ('member_1', 'Ada', 'OWNER', 'ACTIVE', 1, 1, 0);
    INSERT INTO sessions(
      id, member_id, proof_hash, kind, expires_at, idle_expires_at, csrf_hash,
      absolute_expires_at, member_authority_epoch, revision, created_at
    ) VALUES (
      'session_1', 'member_1', X'${"11".repeat(32)}', 'BROWSER', 10000, 10000, X'${"12".repeat(32)}',
      10000, 1, 1, 0
    );
  `);
  let now = 1_000;
  let sequence = 0;
  const authority = createDeviceAuthority({
    database,
    clock: () => now,
    id: (prefix) => `${prefix}_${++sequence}`,
    randomSecret: (prefix) => `${prefix}-${"x".repeat(40)}-${++sequence}`,
    digest: async (value) =>
      value.includes("proof-with")
        ? Uint8Array.from({ length: 32 }, () => 0x11)
        : new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  });
  return { database, authority, now: () => now, advance: (seconds: number) => (now += seconds) };
}

describe("device authorization and DPoP", () => {
  test("browser sessions rotate with idle/absolute bounds and a separate same-origin CSRF proof", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    database.exec(`
      INSERT INTO deployments(id, singleton, team_id, revision, created_at)
        VALUES ('deployment_1', 1, 'team_1', 1, 0);
      INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
        VALUES ('member_1', 'Ada', 'OWNER', 'ACTIVE', 1, 1, 0);
    `);
    let now = 1_000;
    let sequence = 0;
    const digest = async (value: string) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    const sessions = createSessionAuthority({
      database,
      clock: () => now,
      id: (prefix) => `${prefix}_${++sequence}`,
      randomSecret: () => `session-secret-${"x".repeat(32)}-${++sequence}`,
      digest,
    });
    try {
      const issued = await sessions.issue("member_1");
      if (!issued.ok) throw new Error(issued.error.code);
      const access = await sessions.verify(issued.value.actor);
      expect(access.ok).toBe(true);
      if (!access.ok) return;
      expect(
        verifyCsrf(access.value.csrfHash, issued.value.csrfProof, {
          configuredOrigin: "https://collab.test",
          origin: "https://collab.test",
          method: "POST",
          contentType: "application/json; charset=utf-8",
        }),
      ).toBe(true);
      expect(
        verifyCsrf(access.value.csrfHash, issued.value.actor.sessionProof, {
          configuredOrigin: "https://collab.test",
          origin: "https://collab.test",
          method: "POST",
          contentType: "application/json",
        }),
      ).toBe(false);
      const rotated = await sessions.rotate(issued.value.actor);
      expect(rotated.ok).toBe(true);
      expect((await sessions.verify(issued.value.actor)).ok).toBe(false);
      now += 12 * 60 * 60;
      if (rotated.ok) expect((await sessions.verify(rotated.value.actor)).ok).toBe(false);
    } finally {
      database.close();
    }
  });

  test("device access expires in ten minutes and refresh rotates with family replay detection", async () => {
    const f = fixture();
    try {
      const started = await f.authority.begin({
        idempotencyKey: "device_begin_1",
        deviceId: "device_1",
        senderKeyThumbprint: "thumbprint_1",
      });
      if (!started.ok) throw new Error(started.error.code);
      const approved = await f.authority.approve({
        idempotencyKey: "device_approve_1",
        actor: {
          kind: "MEMBER",
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        deviceCodeId: started.value.deviceCodeId,
      });
      expect(approved.ok).toBe(true);
      const approvalReplay = await f.authority.approve({
        idempotencyKey: "device_approve_1",
        actor: {
          kind: "MEMBER",
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        deviceCodeId: started.value.deviceCodeId,
      });
      expect(approvalReplay).toEqual({ ok: true, value: { approved: true } });
      const issued = await f.authority.exchange({
        idempotencyKey: "device_exchange_1",
        deviceCode: started.value.deviceCode,
        senderKeyThumbprint: "thumbprint_1",
      });
      if (!issued.ok) throw new Error(issued.error.code);
      expect(issued.value.accessExpiresAt).toBe(f.now() + 10 * 60);
      const rotated = await f.authority.refresh({
        idempotencyKey: "device_refresh_1",
        refreshCredential: issued.value.refreshCredential,
        senderKeyThumbprint: "thumbprint_1",
      });
      expect(rotated.ok).toBe(true);
      const replay = await f.authority.refresh({
        idempotencyKey: "device_refresh_replay",
        refreshCredential: issued.value.refreshCredential,
        senderKeyThumbprint: "thumbprint_1",
      });
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.error.code).toBe("DEVICE_REFRESH_REPLAY");
    } finally {
      f.database.close();
    }
  });

  test("device approval rejects a browser session at the shared idle deadline", async () => {
    const f = fixture();
    try {
      const started = await f.authority.begin({
        idempotencyKey: "device_begin_idle",
        deviceId: "device_idle",
        senderKeyThumbprint: "thumbprint_idle",
      });
      if (!started.ok) throw new Error(started.error.code);
      f.database.exec("UPDATE sessions SET idle_expires_at = 1000 WHERE id = 'session_1'");
      const approved = await f.authority.approve({
        idempotencyKey: "device_approve_idle",
        actor: {
          kind: "MEMBER",
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        deviceCodeId: started.value.deviceCodeId,
      });
      expect(approved.ok).toBe(false);
      if (!approved.ok) expect(approved.error.code).toBe("SESSION_INVALID");
    } finally {
      f.database.close();
    }
  });

  test("DPoP binds method, normalized URI, nonce, sender key, token hash, time, and replay", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    const verifier = createDpopVerifier({
      database,
      clock: () => 1_000,
      verifyProof: async () => ({
        jti: "proof_1",
        method: "POST",
        uri: "https://collab.test/api/v1/runs",
        issuedAt: 1_000,
        nonce: "nonce_1",
        senderKeyThumbprint: "thumbprint_1",
        accessTokenHash: "a".repeat(64),
      }),
    });
    try {
      const input = {
        proof: "opaque-dpop-proof",
        method: "POST",
        uri: "https://collab.test/api/v1/runs",
        nonce: "nonce_1",
        senderKeyThumbprint: "thumbprint_1",
        accessTokenHash: "a".repeat(64),
      };
      expect((await verifier.verify(input)).ok).toBe(true);
      const replay = await verifier.verify(input);
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.error.code).toBe("DPOP_REPLAY");
      const wrongMethod = await createDpopVerifier({
        database,
        clock: () => 1_000,
        verifyProof: async () => ({
          jti: "proof_2",
          method: "GET",
          uri: input.uri,
          issuedAt: 1_000,
          nonce: input.nonce,
          senderKeyThumbprint: input.senderKeyThumbprint,
          accessTokenHash: input.accessTokenHash,
        }),
      }).verify(input);
      expect(wrongMethod.ok).toBe(false);
    } finally {
      database.close();
    }
  });
});
