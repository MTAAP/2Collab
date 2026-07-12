import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { serializeSignedCookie } from "better-call";
import { createFoundationHttpApp } from "../../../src/server/adapters/http/app.ts";
import { migrate } from "../../../src/server/db/migrate.ts";
import {
  COLLAB_CLI_CLIENT_ID,
  COLLAB_CLI_SCOPE,
  createCollabBetterAuth,
} from "../../../src/server/modules/identity/better-auth.ts";

const ORIGIN = "https://collab.example:8443";
const SECRET = "better-auth-device-adversarial-secret-with-at-least-thirty-two-bytes";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

function insertBrowserSession(database: Database, id: string, token: string, userId: string): void {
  const now = Date.now();
  database
    .query(
      `INSERT INTO auth_sessions(
         id, expiresAt, token, createdAt, updatedAt, userId, purpose,
         memberAuthorityEpoch, absoluteExpiresAt
       ) VALUES (?, ?, ?, ?, ?, ?, 'BROWSER', 1, ?)`,
    )
    .run(id, now + 600_000, token, now, now, userId, now + 600_000);
}

async function signedBrowserCookie(token: string): Promise<string> {
  return serializeSignedCookie("__Secure-better-auth.session_token", token, SECRET);
}

function fixture() {
  const database = new Database(":memory:", { strict: true });
  migrate(database);
  database.exec(`
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
    VALUES
      ('member_1', 'Member One', 'OWNER', 'ACTIVE', 1, 1, 100),
      ('member_2', 'Member Two', 'MEMBER', 'ACTIVE', 1, 1, 100);
    INSERT INTO auth_users(id, name, email, emailVerified, createdAt, updatedAt)
    VALUES
      ('auth_1', 'Member One', 'auth_1@identity.invalid', 0, 100000, 100000),
      ('auth_2', 'Member Two', 'auth_2@identity.invalid', 0, 100000, 100000);
    INSERT INTO auth_member_links(auth_user_id, member_id, authority_epoch_snapshot, created_at)
    VALUES
      ('auth_1', 'member_1', 1, 100),
      ('auth_2', 'member_2', 1, 100);
  `);
  insertBrowserSession(
    database,
    "browser_session_1",
    "browser-one-token-with-at-least-thirty-two-characters",
    "auth_1",
  );
  insertBrowserSession(
    database,
    "browser_session_2",
    "browser-two-token-with-at-least-thirty-two-characters",
    "auth_2",
  );
  const betterAuth = createCollabBetterAuth({
    database,
    publicBaseUrl: ORIGIN,
    rpId: "collab.example",
    rpName: "2Collab Test",
    secret: SECRET,
  });
  const app = createFoundationHttpApp({
    configuredOrigin: ORIGIN,
    authentication: betterAuth.authentication,
    betterAuth: {
      handle: betterAuth.handle,
      bootstrap: {
        database,
        configuredOrigin: ORIGIN,
        bootstrapSecret: "bootstrap-secret-with-at-least-thirty-two-bytes",
        clock: () => Math.floor(Date.now() / 1_000),
        id: (prefix) => `${prefix}_unused`,
        safeEqual: betterAuth.safeEqual,
      },
    },
    rateLimits: { allow: () => true },
    runs: {
      async create() {
        throw new Error("not exercised");
      },
      async inspect() {
        throw new Error("not exercised");
      },
      async cancel() {
        throw new Error("not exercised");
      },
      async resume() {
        throw new Error("not exercised");
      },
      async evidence() {
        throw new Error("not exercised");
      },
    } as never,
  });
  return {
    app,
    betterAuth,
    database,
    handle: async (request: Request) => await app.request(request),
  };
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function requestCode(
  handler: Readonly<{ handle(request: Request): Promise<Response> }>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handler.handle(jsonRequest(`${ORIGIN}/api/auth/device/code`, body, headers));
}

function exchangeCode(
  handler: Readonly<{ handle(request: Request): Promise<Response> }>,
  deviceCode: string,
  clientId = COLLAB_CLI_CLIENT_ID,
): Promise<Response> {
  return handler.handle(
    jsonRequest(`${ORIGIN}/api/auth/device/token`, {
      grant_type: GRANT_TYPE,
      device_code: deviceCode,
      client_id: clientId,
    }),
  );
}

describe("Better Auth RFC 8628 device authorization", () => {
  test("rejects caller-selected users, unknown clients, and widened or missing scopes", async () => {
    const value = fixture();
    for (const body of [
      {
        client_id: COLLAB_CLI_CLIENT_ID,
        scope: COLLAB_CLI_SCOPE,
        user_id: "auth_1",
      },
      { client_id: "attacker-cli", scope: COLLAB_CLI_SCOPE },
      { client_id: COLLAB_CLI_CLIENT_ID },
      { client_id: COLLAB_CLI_CLIENT_ID, scope: "collab:admin" },
      {
        client_id: COLLAB_CLI_CLIENT_ID,
        scope: `${COLLAB_CLI_SCOPE} collab:admin`,
      },
    ]) {
      expect((await requestCode(value, body)).status).toBe(400);
    }
    expect(
      value.database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM auth_device_codes")
        .get()?.count,
    ).toBe(0);
    value.database.close();
  });

  test("pins verification URLs to the configured origin and ignores forwarded headers", async () => {
    const value = fixture();
    const response = await requestCode(
      value,
      { client_id: COLLAB_CLI_CLIENT_ID, scope: COLLAB_CLI_SCOPE },
      {
        forwarded: "host=evil.example;proto=http",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      verification_uri: `${ORIGIN}/device`,
      verification_uri_complete: expect.stringContaining(`${ORIGIN}/device?user_code=`),
      expires_in: 600,
      interval: 5,
    });
    value.database.close();
  });

  test("returns pending and slow-down responses without minting a session", async () => {
    const value = fixture();
    const issued = await requestCode(value, {
      client_id: COLLAB_CLI_CLIENT_ID,
      scope: COLLAB_CLI_SCOPE,
    });
    const { device_code: deviceCode } = (await issued.json()) as {
      device_code: string;
    };

    const pending = await exchangeCode(value, deviceCode);
    expect(pending.status).toBe(400);
    expect(await pending.json()).toMatchObject({
      error: "authorization_pending",
    });
    const tooFast = await exchangeCode(value, deviceCode);
    expect(tooFast.status).toBe(400);
    expect(await tooFast.json()).toMatchObject({ error: "slow_down" });
    expect(
      value.database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM auth_sessions")
        .get()?.count,
    ).toBe(2);
    value.database.close();
  });

  test("binds approval to the claiming browser member and consumes exchange once", async () => {
    const value = fixture();
    const issued = await requestCode(value, {
      client_id: COLLAB_CLI_CLIENT_ID,
      scope: COLLAB_CLI_SCOPE,
    });
    const code = (await issued.json()) as {
      device_code: string;
      user_code: string;
    };
    const memberOneCookie = await signedBrowserCookie(
      "browser-one-token-with-at-least-thirty-two-characters",
    );
    const memberTwoCookie = await signedBrowserCookie(
      "browser-two-token-with-at-least-thirty-two-characters",
    );

    const claimed = await value.handle(
      new Request(`${ORIGIN}/api/auth/device?user_code=${encodeURIComponent(code.user_code)}`, {
        headers: { cookie: memberOneCookie },
      }),
    );
    expect(claimed.status).toBe(200);
    const crossMemberApproval = await value.handle(
      jsonRequest(
        `${ORIGIN}/api/auth/device/approve`,
        { userCode: code.user_code },
        { cookie: memberTwoCookie, origin: ORIGIN },
      ),
    );
    expect(crossMemberApproval.status).toBe(403);

    const approved = await value.handle(
      jsonRequest(
        `${ORIGIN}/api/auth/device/approve`,
        { userCode: code.user_code },
        { cookie: memberOneCookie, origin: ORIGIN },
      ),
    );
    expect(approved.status).toBe(200);
    value.database
      .query("UPDATE auth_device_codes SET lastPolledAt = ? WHERE deviceCode = ?")
      .run(Date.now() - 6_000, code.device_code);

    const exchanged = await exchangeCode(value, code.device_code);
    expect(exchanged.status).toBe(200);
    const token = (await exchanged.json()) as {
      access_token: string;
      expires_in: number;
    };
    expect(token.expires_in).toBeLessThanOrEqual(600);
    expect(token.expires_in).toBeGreaterThan(0);
    expect(exchanged.headers.get("set-cookie")).toBeNull();
    expect(
      (
        await value.betterAuth.authentication.authenticateDevice(
          new Request(`${ORIGIN}/api/v1/runners/pairing/begin`, {
            headers: { authorization: `Bearer ${token.access_token}` },
          }),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await value.betterAuth.authentication.authenticateBrowser(
          new Request(`${ORIGIN}/api/v1/runners/pairing/pair_1/confirm`, {
            headers: { authorization: `Bearer ${token.access_token}` },
          }),
        )
      ).ok,
    ).toBe(false);
    expect(
      value.database
        .query<{ safe_details: string }, []>(
          "SELECT safe_details FROM audit_events WHERE kind = 'AUTH_SESSION_ISSUED' AND subject_id != 'browser_session_1' AND subject_id != 'browser_session_2'",
        )
        .get()?.safe_details,
    ).toBe('{"purpose":"CLI_DEVICE","ttlSeconds":600}');

    const replay = await exchangeCode(value, code.device_code);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    expect(
      value.database
        .query<{ safe_details: string }, []>(
          `SELECT safe_details FROM audit_events
           WHERE kind = 'AUTHENTICATION_FAILED' AND safe_details LIKE '%DEVICE_EXCHANGE%'`,
        )
        .get()?.safe_details,
    ).toBe('{"surface":"DEVICE_EXCHANGE","reason":"ENDPOINT_REJECTED"}');
    value.database.close();
  });

  test("rejects an expired device code at the exact exchange boundary", async () => {
    const value = fixture();
    const issued = await requestCode(value, {
      client_id: COLLAB_CLI_CLIENT_ID,
      scope: COLLAB_CLI_SCOPE,
    });
    const { device_code: deviceCode } = (await issued.json()) as {
      device_code: string;
    };
    value.database
      .query("UPDATE auth_device_codes SET expiresAt = ?, lastPolledAt = NULL WHERE deviceCode = ?")
      .run(0, deviceCode);
    const expired = await exchangeCode(value, deviceCode);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ error: "expired_token" });
    expect(
      value.database
        .query<{ safe_details: string }, []>(
          "SELECT safe_details FROM audit_events WHERE kind = 'AUTHENTICATION_FAILED'",
        )
        .get()?.safe_details,
    ).toBe('{"surface":"DEVICE_EXCHANGE","reason":"ENDPOINT_REJECTED"}');
    value.database.close();
  });
});
