import { expect, test } from "bun:test";
import { createRunnerConfigurationRoutes } from "../../../src/server/adapters/http/routes/runner-configuration.ts";

const actor = {
  kind: "MEMBER" as const,
  memberId: "member_1" as never,
  sessionId: "session_1" as never,
  sessionProof: "proof_1",
};

function dependencies() {
  const calls: unknown[] = [];
  return {
    calls,
    routes: createRunnerConfigurationRoutes({
      configuredOrigin: "https://collab.test",
      authentication: {
        authenticateBrowser: async () => ({ ok: true as const, value: actor }),
        authenticateDevice: async () => ({ ok: true as const, value: actor }),
        verifyBrowserMutation: (request) => request.headers.get("x-collab-csrf") === "csrf_1",
      },
      rateLimits: { allow: () => true },
      registry: {
        registerMapping: async (command) => {
          calls.push(command);
          return {
            ok: true as const,
            value: {
              runnerId: command.runnerId,
              projectId: command.projectId,
              revision: 1,
              localMappingId: command.localMappingId,
              createdAt: 1,
            },
          };
        },
        replaceMapping: async (command) => {
          calls.push(command);
          return {
            ok: true as const,
            value: {
              runnerId: command.runnerId,
              projectId: command.projectId,
              revision: command.expectedRevision + 1,
              localMappingId: command.localMappingId,
              createdAt: 2,
            },
          };
        },
        advertiseProfile: async (command) => {
          calls.push(command);
          return {
            ok: true as const,
            value: {
              runnerId: command.runnerId,
              profileId: (command.profileId ?? "profile_1") as never,
              displayName: command.displayName,
              adapter: command.adapter,
              hosts: command.hosts,
              interactions: command.interactions,
              riskSummary: command.riskSummary,
              version: (command.expectedVersion ?? 0) + 1,
              fingerprint: command.fingerprint,
              createdAt: 2,
            },
          };
        },
      },
    }),
  };
}

test("runner configuration derives owner actor and supports mapping CAS", async () => {
  const fixture = dependencies();
  const created = await fixture.routes.request("/runner_1/mappings", {
    method: "POST",
    headers: {
      authorization: "DPoP access",
      dpop: "proof",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      idempotencyKey: "mapping_create_1",
      projectId: "project_1",
      localMappingId: "opaque_mapping_1",
    }),
  });
  const replaced = await fixture.routes.request("/runner_1/mappings", {
    method: "POST",
    headers: {
      origin: "https://collab.test",
      cookie: "collab_session=session_1.proof_1",
      "x-collab-csrf": "csrf_1",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      idempotencyKey: "mapping_replace_1",
      projectId: "project_1",
      localMappingId: "opaque_mapping_2",
      expectedRevision: 1,
    }),
  });

  expect(created.status).toBe(201);
  expect(replaced.status).toBe(200);
  expect(fixture.calls).toEqual([
    {
      actor,
      idempotencyKey: "mapping_create_1",
      runnerId: "runner_1",
      projectId: "project_1",
      localMappingId: "opaque_mapping_1",
    },
    {
      actor,
      idempotencyKey: "mapping_replace_1",
      runnerId: "runner_1",
      projectId: "project_1",
      localMappingId: "opaque_mapping_2",
      expectedRevision: 1,
    },
  ]);
});

test("runner configuration requires browser mutation proof and rejects private runner facts", async () => {
  const fixture = dependencies();
  const csrf = await fixture.routes.request("/runner_1/profiles", {
    method: "POST",
    headers: {
      origin: "https://collab.test",
      cookie: "collab_session=session_1.proof_1",
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  const privateFacts = await fixture.routes.request("/runner_1/profiles", {
    method: "POST",
    headers: {
      authorization: "DPoP access",
      dpop: "proof",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      idempotencyKey: "profile_create_1",
      displayName: "Codex headless",
      adapter: "CODEX",
      hosts: ["NATIVE"],
      interactions: ["HEADLESS"],
      riskSummary: "Local command execution",
      fingerprint: "a".repeat(64),
      executable: "/usr/local/bin/codex",
    }),
  });

  expect(csrf.status).toBe(403);
  expect(privateFacts.status).toBe(400);
  expect(fixture.calls).toEqual([]);
});

test("runner configuration advertises only a bounded safe profile projection", async () => {
  const fixture = dependencies();
  const response = await fixture.routes.request("/runner_1/profiles", {
    method: "POST",
    headers: {
      authorization: "DPoP access",
      dpop: "proof",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      idempotencyKey: "profile_create_1",
      displayName: "Codex headless",
      adapter: "CODEX",
      hosts: ["NATIVE"],
      interactions: ["HEADLESS"],
      riskSummary: "Local command execution",
      fingerprint: "a".repeat(64),
    }),
  });

  expect(response.status).toBe(201);
  expect(fixture.calls).toEqual([
    {
      actor,
      idempotencyKey: "profile_create_1",
      runnerId: "runner_1",
      profileId: undefined,
      displayName: "Codex headless",
      adapter: "CODEX",
      hosts: ["NATIVE"],
      interactions: ["HEADLESS"],
      riskSummary: "Local command execution",
      fingerprint: "a".repeat(64),
    },
  ]);
});
