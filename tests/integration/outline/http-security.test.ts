import { expect, test } from "bun:test";
import { createFoundationHttpApp } from "../../../src/server/adapters/http/app.ts";

const actor = {
  kind: "MEMBER" as const,
  memberId: "member_1" as never,
  sessionId: "session_1" as never,
  sessionProof: "proof-with-at-least-thirty-two-bytes",
};
const denied = async () => ({
  ok: false as const,
  error: { code: "AUTH_REQUIRED", message: "Authentication is required.", retry: "NEVER" as const },
});

function app(input: Readonly<{ allow?: boolean; browser?: boolean; csrf?: boolean }> = {}) {
  const actors: string[] = [];
  const application = createFoundationHttpApp({
    configuredOrigin: "https://collab.test",
    authentication: {
      authenticateBrowser: input.browser
        ? async () => ({ ok: true as const, value: actor })
        : denied,
      authenticateDevice: input.browser
        ? denied
        : async () => ({ ok: true as const, value: actor }),
      verifyBrowserMutation: () => input.csrf ?? false,
    },
    rateLimits: { allow: () => input.allow ?? true },
    runs: {} as never,
    outline: {
      authorization: {
        async authorizeProject(_member, projectId) {
          return projectId === ("denied_project" as never)
            ? denied()
            : { ok: true, value: { authorized: true as const } };
        },
      },
      connector: {
        async begin(member) {
          actors.push(member.memberId);
          return { ok: true, value: { authorizationUrl: "https://outline.test/oauth" } };
        },
        finish: denied,
        revoke: denied,
      },
      search: {
        async authorize(member) {
          actors.push(member.memberId);
          return {
            ok: true,
            value: {
              actor: { kind: "MEMBER" as const, memberId: member.memberId },
              scope: {
                projectId: "project_1" as never,
                connectorId: "outline_1" as never,
                connectorEpoch: 1,
                references: ["OUTLINE_COLLECTION:c"],
                operations: ["SEARCH"],
              },
              query: {} as never,
            },
          };
        },
        async search() {
          return { ok: true, value: { results: [], truncated: false } } as never;
        },
      },
      documents: { create: denied, edit: denied },
    },
  });
  return { application, actors };
}

test("every Outline HTTP surface requires shared authentication before parsing or invocation", async () => {
  const { application } = app();
  for (const path of [
    "/api/v1/connectors/outline/oauth/begin",
    "/api/v1/connectors/outline/oauth/callback",
    "/api/v1/connectors/outline/revoke",
    "/api/v1/outline/search",
    "/api/v1/outline/documents",
    "/api/v1/outline/documents/doc_1",
  ]) {
    const response = await application.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  }
});

test("Outline routes rate-limit authenticated actors and enforce browser CSRF on mutations", async () => {
  const limited = app({ allow: false });
  const rate = await limited.application.request("/api/v1/outline/search", {
    method: "POST",
    headers: { authorization: "DPoP device", "content-type": "application/json" },
    body: JSON.stringify({ projectId: "project_1" }),
  });
  expect(rate.status).toBe(429);

  const browser = app({ browser: true });
  for (const path of ["/api/v1/connectors/outline/oauth/begin", "/api/v1/outline/documents"]) {
    const response = await browser.application.request(path, {
      method: "POST",
      headers: {
        origin: "https://collab.test",
        cookie: "session=x",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
  }
});

test("Outline routes propagate the authenticated member and reject unbounded or invalid JSON", async () => {
  const secured = app();
  const headers = { authorization: "DPoP device", "content-type": "application/json" };
  const begun = await secured.application.request("/api/v1/connectors/outline/oauth/begin", {
    method: "POST",
    headers,
    body: JSON.stringify({ projectId: "project_1" }),
  });
  expect(begun.status).toBe(200);
  const searched = await secured.application.request("/api/v1/outline/search", {
    method: "POST",
    headers,
    body: JSON.stringify({
      projectId: "project_1",
      connectorId: "outline_1",
      query: {
        query: "design",
        providerLimit: 1,
        resultLimit: 1,
        maximumTotalSnippetBytes: 1024,
        timeoutMs: 1000,
      },
    }),
  });
  expect(searched.status).toBe(200);
  expect(secured.actors).toEqual(["member_1", "member_1"]);

  const deniedProject = await secured.application.request(
    "/api/v1/connectors/outline/oauth/begin",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: "denied_project" }),
    },
  );
  expect(deniedProject.status).toBe(403);
  expect(secured.actors).toEqual(["member_1", "member_1"]);

  const oversized = await secured.application.request("/api/v1/connectors/outline/oauth/begin", {
    method: "POST",
    headers: { ...headers, "content-length": "70000" },
    body: "{}",
  });
  expect(oversized.status).toBe(413);
});
