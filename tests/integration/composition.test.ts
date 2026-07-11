import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/server/app.ts";
import type { FoundationHttpDependencies } from "../../src/server/adapters/http/app.ts";
import type { PublicCreateRunRequest } from "../../src/shared/contracts/public-api.ts";
import type { MemberActor } from "../../src/shared/contracts/actors.ts";

const ACTOR = {
  kind: "MEMBER" as const,
  memberId: "member_1",
  sessionId: "session_1",
  sessionProof: "verified-request-proof-with-at-least-thirty-two-bytes",
} as MemberActor;

const CREATED = {
  kind: "CREATE_RUN" as const,
  record: {
    id: "record_1",
    projectId: "project_1",
    title: "Composition run",
    revision: 1,
    runIds: ["run_1"],
  },
  run: {
    id: "run_1",
    coordinationRecordId: "record_1",
    state: "QUEUED" as const,
    goal: "Composition run",
    repositoryMode: "INSPECT_ONLY" as const,
    repositoryAssurance: "ADVISORY" as const,
    revision: 1,
    attemptIds: ["attempt_1"],
  },
  attempt: { id: "attempt_1", runId: "run_1", state: "PENDING" as const, revision: 1 },
};

function sourceFreeRunInput(): PublicCreateRunRequest {
  return {
    idempotencyKey: "composition_1",
    projectId: "project_1",
    coordination: { kind: "NEW", title: "Composition run", sourceRefs: [] },
    goal: "Composition run",
    repository: { repositoryId: "repository_1" },
    preset: { presetId: "preset_1", presetVersion: 1 },
  };
}

function createTestDependencies(): FoundationHttpDependencies {
  return {
    configuredOrigin: "https://collab.example",
    authentication: {
      authenticateBrowser: async () => ({
        ok: false as const,
        error: { code: "SESSION_REQUIRED", message: "Session required.", retry: "NEVER" as const },
      }),
      authenticateDevice: async () => ({ ok: true as const, value: ACTOR }),
      verifyBrowserMutation: () => false,
    },
    rateLimits: { allow: () => true },
    runs: {
      create: async () => ({ ok: true as const, value: CREATED }),
      inspect: async () => ({
        ok: false as const,
        error: { code: "RUN_NOT_FOUND", message: "Not found.", retry: "NEVER" as const },
      }),
      cancel: async () => ({
        ok: false as const,
        error: { code: "RUN_NOT_FOUND", message: "Not found.", retry: "NEVER" as const },
      }),
      resume: async () => ({
        ok: false as const,
        error: { code: "RUN_NOT_FOUND", message: "Not found.", retry: "NEVER" as const },
      }),
      evidence: async () => ({
        ok: false as const,
        error: { code: "RUN_NOT_FOUND", message: "Not found.", retry: "NEVER" as const },
      }),
    },
  };
}

describe("composition", () => {
  test("composition injects state and package test includes every suite", async () => {
    const app = createApp(createTestDependencies());
    expect((await app.request("/healthz")).status).toBe(200);
    const created = await app.request("/api/v1/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "DPoP test-token",
      },
      body: JSON.stringify(sourceFreeRunInput()),
    });
    expect(created.status).toBe(201);
    const pkg = await Bun.file("package.json").json();
    expect(pkg.scripts.test).toContain("tests/protocol");
    expect(pkg.scripts.test).toContain("tests/runner");
    expect(pkg.scripts.test).toContain("tests/drills");
  });
});
