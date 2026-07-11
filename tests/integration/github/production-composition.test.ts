import { expect, test } from "bun:test";
import { GitHubProjectionSchema } from "../../../src/shared/contracts/github.ts";
import { createProjectionCodec } from "../../../src/server/modules/connectors/contract.ts";
import { createGitHubProductionComposition } from "../../../src/server/github-production-composition.ts";
import { createStubRunOperations } from "../../../src/server/modules/public-surface/run-operations.ts";
import { coordinationFixture } from "../coordination-records/fixture.ts";

test("GitHub production composition is import-safe and mounts HTTP, MCP, Inbox, and durable startup", async () => {
  const database = coordinationFixture();
  const authentication = {
    authenticateBrowser: async () => ({
      ok: false as const,
      error: { code: "SESSION_REQUIRED", message: "Required.", retry: "NEVER" as const },
    }),
    authenticateDevice: async () => ({
      ok: false as const,
      error: {
        code: "DEVICE_AUTHENTICATION_REQUIRED",
        message: "Required.",
        retry: "NEVER" as const,
      },
    }),
    verifyBrowserMutation: () => false,
  };
  const composition = createGitHubProductionComposition({
    database,
    clock: () => 1,
    id: (prefix) => `${prefix}_1`,
    digest: async (value) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    attemptAuthority: {
      verify: async () => ({
        ok: false,
        error: { code: "DENIED", message: "Denied.", retry: "NEVER" },
      }),
      consume: async () => ({
        ok: false,
        error: { code: "DENIED", message: "Denied.", retry: "NEVER" },
      }),
    },
    projectionCodec: () => createProjectionCodec(GitHubProjectionSchema),
    github: {
      inspect: async () => ({
        ok: false,
        error: { code: "MISSING", message: "Missing.", retry: "NEVER" },
      }),
      mutate: async () => ({
        ok: false,
        error: { code: "DENIED", message: "Denied.", retry: "NEVER" },
      }),
      async *scan() {},
      observeChecks: async () => ({
        ok: false,
        error: { code: "MISSING", message: "Missing.", retry: "NEVER" },
      }),
      listDependencies: async () => ({
        ok: false,
        error: { code: "MISSING", message: "Missing.", retry: "NEVER" },
      }),
    },
    authentication,
    rateLimits: { allow: () => true },
    runs: createStubRunOperations(),
    configuredOrigin: "https://collab.example",
    webhooks: {
      receive: async () => ({
        ok: false,
        error: { code: "DENIED", message: "Denied.", retry: "NEVER" },
      }),
    },
    planning: {
      authentication,
      rateLimits: { allow: () => true },
      authorizeProject: async () => ({ ok: true, value: { authorized: true } }),
      list: async () => ({ ok: true, value: [] }),
    },
    inbox: {
      authentication,
      rateLimits: { allow: () => true },
      listInbox: async () => ({ ok: true, value: [] }),
      listCommandCenter: async () => ({ ok: true, value: [] }),
    },
    scope: () => ({ ok: false, error: { code: "MISSING", message: "Missing.", retry: "NEVER" } }),
    reconcile: async () => ({ ok: true, value: {} }),
  });
  expect(composition.resources.foundation?.mcp).toBeFunction();
  expect(composition.resources.github?.issues.mutate).toBeFunction();
  expect(composition.resources.github?.planning).toBeDefined();
  expect(composition.resources.inbox).toBeDefined();
  expect(composition.scheduler.state().stopped).toBe(true);
  await composition.resources.startup?.();
  expect(composition.scheduler.state().stopped).toBe(false);
  composition.scheduler.stop();
  database.close();
});
