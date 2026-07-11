import { describe, expect, test } from "bun:test";
import { createBrowserAuthRoutes } from "../../src/server/adapters/http/routes/auth.ts";

const SECRET = "invitation-secret-with-at-least-thirty-two-bytes";
const SESSION_PROOF = "session-proof-with-at-least-thirty-two-bytes";

describe("browser authentication HTTP boundary", () => {
  test("fragment exchange returns metadata and only a path-scoped HttpOnly cookie", async () => {
    const app = createBrowserAuthRoutes({
      configuredOrigin: "https://collab.example",
      rateLimits: { allow: () => true },
      identity: {
        async beginPasskeyRegistration() {
          throw new Error("not exercised");
        },
        async bootstrap() {
          throw new Error("not exercised");
        },
        async exchangeInvitation(input) {
          expect(input.secret).toBe(SECRET);
          return {
            ok: true,
            value: {
              invitationId: "invite_1",
              secret: "exchange-secret-with-at-least-thirty-two-bytes",
              expiresAt: 900 as never,
              httpOnly: true,
            },
          };
        },
      },
    });
    const response = await app.request("/invitations/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://collab.example" },
      body: JSON.stringify({ secret: SECRET, idempotencyKey: "exchange_1" }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("collab_invitation=");
    expect(cookie).toContain("Path=/join");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("exchange-secret");
    expect(body).toContain("invite_1");
  });

  test("bootstrap puts the session proof in an HttpOnly cookie and returns only CSRF proof", async () => {
    const app = createBrowserAuthRoutes({
      configuredOrigin: "https://collab.example",
      rateLimits: { allow: () => true },
      identity: {
        async beginPasskeyRegistration() {
          throw new Error("not exercised");
        },
        async exchangeInvitation() {
          throw new Error("not exercised");
        },
        async bootstrap() {
          return {
            ok: true,
            value: {
              id: "session_1" as never,
              memberId: "member_1" as never,
              expiresAt: 900 as never,
              proof: SESSION_PROOF,
              csrfProof: "csrf-proof-with-at-least-thirty-two-bytes",
            },
          };
        },
      },
    });
    const response = await app.request("/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://collab.example" },
      body: JSON.stringify({
        idempotencyKey: "bootstrap_1",
        bootstrapSecret: "bootstrap-secret-with-at-least-thirty-two-bytes",
        displayName: "Tim",
        credentialName: "Mac",
        challengeId: "challenge_1",
        response: {},
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("collab_session=session_1.");
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(SESSION_PROOF);
    expect(body).toContain("csrf-proof");
  });
});
