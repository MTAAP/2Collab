import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { serializeSignedCookie } from "better-call";
import { createFoundationHttpApp } from "../../../src/server/adapters/http/app.ts";
import { migrate } from "../../../src/server/db/migrate.ts";
import { createCollabBetterAuth } from "../../../src/server/modules/identity/better-auth.ts";

const ORIGIN = "https://collab.example:8443";
const SECRET = "better-auth-adversarial-secret-with-at-least-thirty-two-bytes";
const BROWSER_TOKEN = "browser-token-with-at-least-thirty-two-characters";
const CLI_TOKEN = "cli-token-with-at-least-thirty-two-characters";

const createRunRequest = {
  idempotencyKey: "better_auth_boundary_1",
  projectId: "project_1",
  coordination: { kind: "NEW", title: "Better Auth boundary", sourceRefs: [] },
  goal: "Prove authentication modes cannot be confused.",
  repository: { repositoryId: "repository_1" },
  preset: { presetId: "preset_1", presetVersion: 1 },
};

const createdRun = {
  kind: "CREATE_RUN" as const,
  record: {
    id: "record_1",
    projectId: "project_1",
    title: "Better Auth boundary",
    revision: 1,
    runIds: ["run_1"],
  },
  run: {
    id: "run_1",
    coordinationRecordId: "record_1",
    state: "QUEUED" as const,
    goal: createRunRequest.goal,
    repositoryMode: "INSPECT_ONLY" as const,
    repositoryAssurance: "ADVISORY" as const,
    revision: 1,
    attemptIds: ["attempt_1"],
  },
  attempt: { id: "attempt_1", runId: "run_1", state: "PENDING" as const, revision: 1 },
};

function insertSession(
  database: Database,
  input: Readonly<{
    id: string;
    token: string;
    userId: string;
    purpose: "BROWSER" | "CLI_DEVICE";
    authorityEpoch?: number;
  }>,
): void {
  const now = Date.now();
  database
    .query(
      `INSERT INTO auth_sessions(
         id, expiresAt, token, createdAt, updatedAt, userId, purpose,
         memberAuthorityEpoch, absoluteExpiresAt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      now + 600_000,
      input.token,
      now,
      now,
      input.userId,
      input.purpose,
      input.authorityEpoch ?? 3,
      now + 600_000,
    );
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
      ('member_active', 'Active Member', 'OWNER', 'ACTIVE', 3, 1, 100),
      ('member_revoked', 'Revoked Member', 'MEMBER', 'REVOKED', 4, 1, 100);
    INSERT INTO auth_users(id, name, email, emailVerified, createdAt, updatedAt)
    VALUES
      ('auth_active', 'Active Member', 'auth_active@identity.invalid', 0, 100000, 100000),
      ('auth_revoked', 'Revoked Member', 'auth_revoked@identity.invalid', 0, 100000, 100000),
      ('auth_unlinked', 'Unlinked User', 'auth_unlinked@identity.invalid', 0, 100000, 100000);
    INSERT INTO auth_member_links(auth_user_id, member_id, authority_epoch_snapshot, created_at)
    VALUES
      ('auth_active', 'member_active', 3, 100),
      ('auth_revoked', 'member_revoked', 4, 100);
  `);
  insertSession(database, {
    id: "session_browser",
    token: BROWSER_TOKEN,
    userId: "auth_active",
    purpose: "BROWSER",
  });
  insertSession(database, {
    id: "session_cli",
    token: CLI_TOKEN,
    userId: "auth_active",
    purpose: "CLI_DEVICE",
  });
  insertSession(database, {
    id: "session_unlinked",
    token: "unlinked-token-with-at-least-thirty-two-characters",
    userId: "auth_unlinked",
    purpose: "CLI_DEVICE",
  });
  insertSession(database, {
    id: "session_revoked",
    token: "revoked-token-with-at-least-thirty-two-characters",
    userId: "auth_revoked",
    purpose: "CLI_DEVICE",
    authorityEpoch: 4,
  });

  const betterAuth = createCollabBetterAuth({
    database,
    publicBaseUrl: ORIGIN,
    rpId: "collab.example",
    rpName: "2Collab Test",
    secret: SECRET,
  });
  let creates = 0;
  const app = createFoundationHttpApp({
    configuredOrigin: ORIGIN,
    authentication: betterAuth.authentication,
    rateLimits: { allow: () => true },
    runs: {
      async create() {
        creates += 1;
        return { ok: true, value: createdRun };
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
  return { app, betterAuth, database, creates: () => creates };
}

function postRun(
  app: ReturnType<typeof createFoundationHttpApp>,
  headers: Record<string, string>,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(`${ORIGIN}/api/v1/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(createRunRequest),
      }),
    ),
  );
}

describe("Better Auth HTTP trust boundary", () => {
  test("keeps browser session bearers out of JavaScript-visible auth responses", async () => {
    const app = createFoundationHttpApp({
      configuredOrigin: ORIGIN,
      rateLimits: { allow: () => true },
      betterAuth: {
        async handle(request: Request) {
          if (new URL(request.url).pathname === "/api/auth/device/token")
            return Response.json(
              { access_token: CLI_TOKEN, token_type: "Bearer", expires_in: 600 },
              {
                headers: {
                  "set-auth-token": CLI_TOKEN,
                  "set-cookie": "better-auth.device=must-not-be-set",
                },
              },
            );
          return Response.json(
            {
              session: { id: "session_browser", token: BROWSER_TOKEN },
              user: { id: "auth_active", name: "Active Member" },
            },
            {
              headers: {
                "set-auth-token": BROWSER_TOKEN,
                "set-cookie": "__Secure-better-auth.session_token=opaque; HttpOnly; Secure",
              },
            },
          );
        },
      },
    } as never);

    const browser = await app.request(`${ORIGIN}/api/auth/passkey/verify-authentication`, {
      method: "POST",
    });
    expect(browser.headers.get("set-auth-token")).toBeNull();
    expect(browser.headers.get("set-cookie")).toContain("HttpOnly");
    expect(await browser.json()).toEqual({
      session: { id: "session_browser" },
      user: { id: "auth_active", name: "Active Member" },
    });

    const device = await app.request(`${ORIGIN}/api/auth/device/token`, { method: "POST" });
    expect(device.headers.get("set-auth-token")).toBeNull();
    expect(device.headers.get("set-cookie")).toBeNull();
    expect(await device.json()).toMatchObject({ access_token: CLI_TOKEN });
  });

  test("blocks cross-site passkey challenges and rate-limits unauthenticated auth issuance", async () => {
    let handled = 0;
    const app = createFoundationHttpApp({
      configuredOrigin: ORIGIN,
      rateLimits: { allow: () => false },
      betterAuth: {
        async handle() {
          handled += 1;
          return Response.json({ ok: true });
        },
      },
    } as never);

    const crossSite = await app.request(
      `${ORIGIN}/api/auth/passkey/generate-authenticate-options`,
      {
        headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      },
    );
    expect(crossSite.status).toBe(403);

    const limited = await app.request(`${ORIGIN}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "2collab-cli", scope: "collab:cli" }),
    });
    expect(limited.status).toBe(429);
    expect(handled).toBe(0);
  });

  test("requires the exact configured origin including port and ignores forwarded authority", async () => {
    const value = fixture();
    const cookie = await signedBrowserCookie(BROWSER_TOKEN);
    const validHeaders = {
      cookie,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
    };

    expect((await postRun(value.app, validHeaders)).status).toBe(201);
    for (const origin of [
      "https://collab.example",
      "https://collab.example:443",
      "http://collab.example:8443",
      "https://evil.example:8443",
      "null",
    ]) {
      expect(
        (
          await postRun(value.app, {
            ...validHeaders,
            origin,
            forwarded: `host=collab.example:8443;proto=https`,
            "x-forwarded-host": "collab.example:8443",
            "x-forwarded-proto": "https",
          })
        ).status,
      ).toBe(403);
    }

    expect(
      (
        await postRun(value.app, {
          ...validHeaders,
          forwarded: "host=evil.example;proto=http",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "http",
        })
      ).status,
    ).toBe(201);
    expect(value.creates()).toBe(2);
    value.database.close();
  });

  test("rejects missing or cross-site Fetch Metadata and non-JSON browser mutations", async () => {
    const value = fixture();
    const cookie = await signedBrowserCookie(BROWSER_TOKEN);
    const rejectedHeaders: Record<string, string>[] = [
      { cookie, origin: ORIGIN },
      { cookie, origin: ORIGIN, "sec-fetch-site": "same-site" },
      { cookie, origin: ORIGIN, "sec-fetch-site": "cross-site" },
      {
        cookie,
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        "content-type": "text/plain",
      },
      {
        cookie,
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
      },
    ];
    for (const headers of rejectedHeaders) {
      expect((await postRun(value.app, headers)).status).toBe(403);
    }
    expect(value.creates()).toBe(0);
    value.database.close();
  });

  test("keeps browser and CLI session purposes separate at the real route", async () => {
    const value = fixture();
    const browserCookie = await signedBrowserCookie(BROWSER_TOKEN);
    const cliCookie = await signedBrowserCookie(CLI_TOKEN);

    expect(
      (
        await postRun(value.app, {
          cookie: browserCookie,
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
        })
      ).status,
    ).toBe(201);
    expect((await postRun(value.app, { authorization: `Bearer ${CLI_TOKEN}` })).status).toBe(201);
    expect(
      (
        await postRun(value.app, {
          cookie: cliCookie,
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
        })
      ).status,
    ).toBe(401);
    expect((await postRun(value.app, { authorization: `Bearer ${BROWSER_TOKEN}` })).status).toBe(
      401,
    );
    expect(
      (
        await postRun(value.app, {
          cookie: browserCookie,
          authorization: `Bearer ${CLI_TOKEN}`,
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
        })
      ).status,
    ).toBe(401);
    expect(value.creates()).toBe(2);
    value.database.close();
  });

  test("denies valid Better Auth sessions without an active linked Collab member", async () => {
    const value = fixture();
    expect(
      (
        await postRun(value.app, {
          authorization: "Bearer unlinked-token-with-at-least-thirty-two-characters",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await postRun(value.app, {
          authorization: "Bearer revoked-token-with-at-least-thirty-two-characters",
        })
      ).status,
    ).toBe(401);
    expect(value.creates()).toBe(0);
    value.database.close();
  });
});
