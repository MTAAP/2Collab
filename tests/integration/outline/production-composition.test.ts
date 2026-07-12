import { expect, test } from "bun:test";
import { createFoundationHttpApp } from "../../../src/server/adapters/http/app.ts";

const denied = async () => ({
  ok: false as const,
  error: { code: "DENIED", message: "Denied.", retry: "NEVER" as const },
});

test("production HTTP composition mounts injected Outline connector, search, and document routes", async () => {
  const app = createFoundationHttpApp({
    configuredOrigin: "https://collab.test",
    authentication: {
      authenticateBrowser: denied,
      authenticateDevice: denied,
      verifyBrowserMutation: () => false,
    },
    rateLimits: { allow: () => true },
    runs: {} as never,
    outline: {
      authorization: { authorizeProject: denied },
      connector: { begin: denied, finish: denied, revoke: denied },
      search: { authorize: denied, search: denied },
      documents: { create: denied, edit: denied },
    },
  });
  for (const path of [
    "/api/v1/connectors/outline/oauth/begin",
    "/api/v1/outline/search",
    "/api/v1/outline/documents",
  ]) {
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).not.toBe(404);
  }
});
