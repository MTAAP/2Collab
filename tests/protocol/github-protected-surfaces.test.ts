import { expect, test } from "bun:test";
import type { MemberActor } from "../../src/shared/contracts/actors.ts";
import { createGitHubPlanningRoutes } from "../../src/server/adapters/http/routes/github-planning.ts";
import { createInboxRoutes } from "../../src/server/adapters/http/routes/inbox.ts";

const actor = (memberId: string) =>
  ({
    kind: "MEMBER",
    memberId,
    sessionId: `session_${memberId}`,
    sessionProof: "x".repeat(32),
  }) as MemberActor;
const authentication = (memberId: string) => ({
  authenticateBrowser: async () => ({
    ok: false as const,
    error: { code: "SESSION_REQUIRED", message: "Session required.", retry: "NEVER" as const },
  }),
  authenticateDevice: async () => ({ ok: true as const, value: actor(memberId) }),
  verifyBrowserMutation: () => false,
});
const request = (path: string) =>
  new Request(`https://collab.example${path}`, {
    headers: { authorization: "DPoP token", dpop: "proof" },
  });

test("GitHub planning authenticates, rate limits, and authorizes the requested project", async () => {
  let listed = false;
  const denied = createGitHubPlanningRoutes({
    authentication: authentication("member_a"),
    rateLimits: { allow: () => true },
    authorizeProject: async () => ({
      ok: false,
      error: { code: "PROJECT_ACCESS_DENIED", message: "Denied.", retry: "NEVER" },
    }),
    list: async () => {
      listed = true;
      return { ok: true, value: [] };
    },
  });
  expect((await denied.request(request("/api/v1/projects/project_b/github/planning"))).status).toBe(
    403,
  );
  expect(listed).toBe(false);

  const limited = createGitHubPlanningRoutes({
    authentication: authentication("member_a"),
    rateLimits: { allow: () => false },
    authorizeProject: async () => ({ ok: true, value: { authorized: true } }),
    list: async () => ({ ok: true, value: [] }),
  });
  expect(
    (await limited.request(request("/api/v1/projects/project_a/github/planning"))).status,
  ).toBe(429);
});

test("Inbox and Command Center queries receive only the authenticated member actor", async () => {
  const seen: string[] = [];
  const routes = createInboxRoutes({
    authentication: authentication("member_a"),
    rateLimits: { allow: () => true },
    listInbox: async (member) => {
      seen.push(member.memberId);
      return { ok: true, value: [] };
    },
    listCommandCenter: async (member) => {
      seen.push(member.memberId);
      return { ok: true, value: [] };
    },
  });
  expect((await routes.request(request("/api/v1/inbox"))).status).toBe(200);
  expect((await routes.request(request("/api/v1/command-center"))).status).toBe(200);
  expect(seen).toEqual(["member_a", "member_a"]);
});
