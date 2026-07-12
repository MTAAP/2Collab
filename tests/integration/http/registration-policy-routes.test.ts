import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createRegistrationPolicyRoutes } from "../../../src/server/adapters/http/routes/registration-policy.ts";
import { migrate } from "../../../src/server/db/migrate.ts";
import { createRegistrationPolicyService } from "../../../src/server/modules/identity/registration-policy.ts";

const origin = "https://collab.example:8443";

function fixture() {
  const database = new Database(":memory:", { strict: true });
  migrate(database);
  database.exec(`
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
    VALUES
      ('owner_1', 'Owner', 'OWNER', 'ACTIVE', 1, 1, 100),
      ('member_1', 'Member', 'MEMBER', 'ACTIVE', 1, 1, 100);
  `);
  let sequence = 0;
  const app = createRegistrationPolicyRoutes({
    configuredOrigin: origin,
    rateLimits: { allow: () => true },
    emailLoginEnabled: true,
    service: createRegistrationPolicyService({
      database,
      clock: () => 2_000_000_000,
      id: (prefix) => `${prefix}_${++sequence}`,
    }),
    authentication: {
      async authenticateBrowser(request) {
        const memberId = request.headers.get("cookie")?.includes("member_1")
          ? "member_1"
          : "owner_1";
        return {
          ok: true as const,
          value: {
            kind: "MEMBER" as const,
            memberId: memberId as never,
            sessionId: "session_1" as never,
            sessionProof: "browser-session-proof-with-at-least-thirty-two-bytes",
          },
        };
      },
      async authenticateDevice() {
        throw new Error("not exercised");
      },
      verifyBrowserMutation(request) {
        return request.headers.get("sec-fetch-site") === "same-origin";
      },
    },
  });
  return { app, database };
}

const headers = {
  cookie: "session=owner_1",
  origin,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};

describe("owner registration-policy HTTP surface", () => {
  test("reads and revision-guards mode/rule mutations", async () => {
    const { app, database } = fixture();
    const initial = await app.request("/registration-policy", { headers });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      ok: true,
      value: { mode: "INVITE_ONLY", revision: 1, emailLoginEnabled: true, rules: [] },
    });
    const mode = await app.request("/registration-policy", {
      method: "PUT",
      headers,
      body: JSON.stringify({ expectedRevision: 1, mode: "ALLOWLIST" }),
    });
    expect(mode.status).toBe(200);
    const rule = await app.request("/registration-policy/rules", {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedPolicyRevision: 2,
        effect: "ALLOW",
        matcher: "DOMAIN",
        value: "Example.COM",
        includeSubdomains: true,
      }),
    });
    expect(rule.status).toBe(201);
    expect(await rule.json()).toMatchObject({
      value: { policyRevision: 3, rule: { value: "example.com", includeSubdomains: true } },
    });
    expect(
      (
        await app.request("/registration-policy", {
          method: "PUT",
          headers,
          body: JSON.stringify({ expectedRevision: 2, mode: "CLOSED" }),
        })
      ).status,
    ).toBe(409);
    database.close();
  });

  test("denies members and browser mutations without same-origin proof", async () => {
    const { app, database } = fixture();
    expect(
      (await app.request("/registration-policy", { headers: { ...headers, cookie: "member_1" } }))
        .status,
    ).toBe(403);
    expect(
      (
        await app.request("/registration-policy", {
          method: "PUT",
          headers: { ...headers, origin: "https://evil.example" },
          body: JSON.stringify({ expectedRevision: 1, mode: "CLOSED" }),
        })
      ).status,
    ).toBe(403);
    database.close();
  });
});
