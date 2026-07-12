import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { serializeSignedCookie } from "better-call";
import { migrate } from "../../../src/server/db/migrate.ts";
import {
  COLLAB_CLI_CLIENT_ID,
  COLLAB_CLI_SCOPE,
  createCollabBetterAuth,
} from "../../../src/server/modules/identity/better-auth.ts";

const origin = "https://collab.example:8443";
const secret = "better-auth-test-secret-with-at-least-thirty-two-bytes";

function fixture() {
  const now = Math.floor(Date.now() / 1_000);
  const database = new Database(":memory:", { strict: true });
  migrate(database);
  database.exec(`
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
    VALUES ('member_1', 'Member One', 'OWNER', 'ACTIVE', 2, 1, 100);
    INSERT INTO auth_users(id, name, email, emailVerified, createdAt, updatedAt)
    VALUES ('auth_1', 'Member One', 'auth_1@identity.invalid', 0, 100000, 100000);
    INSERT INTO auth_member_links(auth_user_id, member_id, authority_epoch_snapshot, created_at)
    VALUES ('auth_1', 'member_1', 2, 100);
  `);
  const auth = createCollabBetterAuth({
    database,
    publicBaseUrl: origin,
    rpId: "collab.example",
    rpName: "2Collab Test",
    secret,
    clock: () => now,
  });
  return { auth, database, now };
}

describe("embedded Better Auth sessions", () => {
  test("audits an issued browser session with bounded non-secret details", async () => {
    const { auth, database } = fixture();
    const context = await auth.auth.$context;
    const session = await context.internalAdapter.createSession("auth_1");
    expect(session).not.toBeNull();
    expect(
      database
        .query<{ actor_id: string; subject_id: string; safe_details: string }, []>(
          `SELECT actor_id, subject_id, safe_details FROM audit_events
           WHERE kind = 'AUTH_SESSION_ISSUED'`,
        )
        .get(),
    ).toEqual({
      actor_id: "member_1",
      subject_id: session?.id,
      safe_details: '{"purpose":"BROWSER","ttlSeconds":604800}',
    });
    expect(
      database
        .query<{ safe_details: string }, []>(
          "SELECT safe_details FROM audit_events WHERE kind = 'AUTH_SESSION_ISSUED'",
        )
        .get()?.safe_details,
    ).not.toContain(session?.token);
    database.close();
  });

  test("keeps browser and CLI-device authority in separate modes", async () => {
    const { auth, database, now } = fixture();
    database
      .query(
        `INSERT INTO auth_sessions(
          id, expiresAt, token, createdAt, updatedAt, userId, purpose,
          memberAuthorityEpoch, absoluteExpiresAt
        ) VALUES ('session_cli', ?, 'cli-token-with-at-least-thirty-two-characters',
          ?, ?, 'auth_1', 'CLI_DEVICE', 2, ?)`,
      )
      .run((now + 600) * 1_000, now * 1_000, now * 1_000, (now + 600) * 1_000);
    const request = new Request(`${origin}/api/v1/runners/pairing/begin`, {
      method: "POST",
      headers: {
        authorization: "Bearer cli-token-with-at-least-thirty-two-characters",
      },
    });
    expect((await auth.authentication.authenticateDevice(request)).ok).toBe(true);
    expect((await auth.authentication.authenticateRunnerDevice?.(request))?.ok).toBe(true);
    expect((await auth.authentication.authenticateBrowser(request)).ok).toBe(false);

    database.query("UPDATE members SET status = 'REVOKED' WHERE id = 'member_1'").run();
    expect((await auth.authentication.authenticateDevice(request)).ok).toBe(false);
    database.close();
  });

  test("audits invalid and expired sessions with bounded generic details", async () => {
    const { auth, database, now } = fixture();
    database
      .query(
        `INSERT INTO auth_sessions(
          id, expiresAt, token, createdAt, updatedAt, userId, purpose,
          memberAuthorityEpoch, absoluteExpiresAt
        ) VALUES ('session_expired', ?, 'expired-browser-token-with-at-least-thirty-two-characters',
          ?, ?, 'auth_1', 'BROWSER', 2, ?)`,
      )
      .run((now - 1) * 1_000, now * 1_000, now * 1_000, (now - 1) * 1_000);
    const expiredCookie = await serializeSignedCookie(
      "__Secure-better-auth.session_token",
      "expired-browser-token-with-at-least-thirty-two-characters",
      secret,
    );

    expect(
      (
        await auth.authentication.authenticateBrowser(
          new Request(`${origin}/api/v1/runs`, { headers: { cookie: expiredCookie } }),
        )
      ).ok,
    ).toBeFalse();
    expect(
      (
        await auth.authentication.authenticateBrowser(
          new Request(`${origin}/api/v1/runs`, {
            headers: { cookie: "__Secure-better-auth.session_token=invalid-browser-session" },
          }),
        )
      ).ok,
    ).toBeFalse();
    expect(
      (
        await auth.authentication.authenticateDevice(
          new Request(`${origin}/api/v1/runs`, {
            headers: { authorization: "Bearer invalid-device-bearer-value" },
          }),
        )
      ).ok,
    ).toBeFalse();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(
        (
          await auth.authentication.authenticateDevice(
            new Request(`${origin}/api/v1/runs`, {
              headers: { authorization: `Bearer invalid-device-bearer-${attempt}` },
            }),
          )
        ).ok,
      ).toBeFalse();
    }

    expect(
      database
        .query<{ safe_details: string }, []>(
          "SELECT safe_details FROM audit_events WHERE kind = 'AUTHENTICATION_FAILED' ORDER BY created_at, rowid",
        )
        .all(),
    ).toEqual([
      { safe_details: '{"surface":"BROWSER","reason":"SESSION_REJECTED"}' },
      { safe_details: '{"surface":"BROWSER","reason":"SESSION_REJECTED"}' },
      ...Array.from({ length: 10 }, () => ({
        safe_details: '{"surface":"CLI_DEVICE","reason":"SESSION_REJECTED"}',
      })),
    ]);
    const auditWire = JSON.stringify(
      database
        .query<{ safe_details: string }, []>(
          "SELECT safe_details FROM audit_events WHERE kind = 'AUTHENTICATION_FAILED'",
        )
        .all(),
    );
    expect(auditWire).not.toContain("expired-browser-token");
    expect(auditWire).not.toContain("invalid-browser-session");
    expect(auditWire).not.toContain("invalid-device-bearer");
    database.close();
  });

  test("audits and rejects mixed browser and CLI authentication at the runner boundary", async () => {
    const { auth, database, now } = fixture();
    database
      .query(
        `INSERT INTO auth_sessions(
          id, expiresAt, token, createdAt, updatedAt, userId, purpose,
          memberAuthorityEpoch, absoluteExpiresAt
        ) VALUES ('session_cli_mixed', ?, 'mixed-cli-token-with-at-least-thirty-two-characters',
          ?, ?, 'auth_1', 'CLI_DEVICE', 2, ?)`,
      )
      .run((now + 600) * 1_000, now * 1_000, now * 1_000, (now + 600) * 1_000);
    const result = await auth.authentication.authenticateRunnerDevice(
      new Request(`${origin}/api/v1/runners/pairing/begin`, {
        headers: {
          authorization: "Bearer mixed-cli-token-with-at-least-thirty-two-characters",
          cookie: "unrelated_browser_cookie=present",
        },
      }),
    );
    expect(result.ok).toBeFalse();
    expect(
      database
        .query<{ safe_details: string }, []>(
          "SELECT safe_details FROM audit_events WHERE kind = 'AUTHENTICATION_FAILED'",
        )
        .get()?.safe_details,
    ).toBe('{"surface":"RUNNER_PAIRING","reason":"MIXED_MODE"}');
    database.close();
  });

  test("audits Better Auth passkey endpoint failures without request material", async () => {
    const { auth, database } = fixture();
    const response = await auth.handle(
      new Request(`${origin}/api/auth/passkey/verify-authentication`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ response: { id: "attacker-controlled-credential" } }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      database
        .query<{ safe_details: string }, []>(
          "SELECT safe_details FROM audit_events WHERE kind = 'AUTHENTICATION_FAILED'",
        )
        .get()?.safe_details,
    ).toBe('{"surface":"PASSKEY","reason":"ENDPOINT_REJECTED"}');
    expect(
      database
        .query<{ safe_details: string }, []>(
          "SELECT safe_details FROM audit_events WHERE kind = 'AUTHENTICATION_FAILED'",
        )
        .get()?.safe_details,
    ).not.toContain("attacker-controlled-credential");
    database.close();
  });

  test("accepts only the exact RFC 8628 client and closed scope", async () => {
    const { auth, database } = fixture();
    const requestCode = (body: unknown) =>
      auth.handle(
        new Request(`${origin}/api/auth/device/code`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    expect(
      (
        await requestCode({
          client_id: COLLAB_CLI_CLIENT_ID,
          scope: COLLAB_CLI_SCOPE,
          user_id: "auth_1",
        })
      ).status,
    ).toBe(400);
    expect((await requestCode({ client_id: "other", scope: COLLAB_CLI_SCOPE })).status).toBe(400);
    const accepted = await requestCode({
      client_id: COLLAB_CLI_CLIENT_ID,
      scope: COLLAB_CLI_SCOPE,
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      verification_uri: `${origin}/device`,
      expires_in: 600,
    });
    database.close();
  });

  test("retries a verified registration only when no passkey was stored", async () => {
    const { auth, database, now } = fixture();
    const context = "retryable-registration-context-with-at-least-thirty-two-bytes";
    const secretHash = new Bun.CryptoHasher("sha256").update(context).digest();
    database
      .query(
        `INSERT INTO auth_registration_tickets(
           id, secret_hash, auth_user_id, intended_member_id, display_name,
           purpose, state, created_at, expires_at
         ) VALUES ('ticket_retry', ?, 'auth_1', 'member_1', 'Member One',
           'HOST_RECOVERY', 'PASSKEY_VERIFIED', ?, ?)`,
      )
      .run(secretHash, now - 1, now + 300);
    const request = () =>
      auth.handle(
        new Request(
          `${origin}/api/auth/passkey/generate-register-options?context=${encodeURIComponent(context)}`,
        ),
      );

    expect((await request()).status).toBe(200);
    database
      .query(
        `INSERT INTO auth_passkeys(
           id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt
         ) VALUES ('passkey_retry', 'Recovery', 'public', 'auth_1', 'credential_retry',
           0, 'multiDevice', 1, ?)`,
      )
      .run(now * 1_000);
    expect((await request()).status).not.toBe(200);
    database.close();
  });

  test("requires exact origin, JSON, and same-origin Fetch Metadata for app mutations", () => {
    const { auth, database } = fixture();
    const valid = new Request(`${origin}/api/v1/runners/pairing/id/confirm`, {
      method: "POST",
      headers: {
        origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
    });
    expect(auth.authentication.verifyBrowserMutation(valid, {} as never)).toBe(true);
    expect(
      auth.authentication.verifyBrowserMutation(
        new Request(valid, {
          headers: { origin, "content-type": "application/json" },
        }),
        {} as never,
      ),
    ).toBe(false);
    database.close();
  });
});
