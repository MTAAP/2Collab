import { describe, expect, test } from "bun:test";
import { createFoundationHttpApp } from "../../src/server/adapters/http/app.ts";
import type { PublicCreateRunRequest } from "../../src/shared/contracts/public-api.ts";
import {
  PublicCreateRunRequestSchema,
  PublicRunResultSchema,
} from "../../src/shared/contracts/public-api.ts";

const ACTOR = {
  kind: "MEMBER" as const,
  memberId: "member_1" as never,
  sessionId: "session_1" as never,
  sessionProof: "verified-request-proof-with-at-least-thirty-two-bytes",
};

const REQUEST: PublicCreateRunRequest = {
  idempotencyKey: "launch_1",
  projectId: "project_1",
  coordination: { kind: "NEW", title: "Surface parity", sourceRefs: [] },
  goal: "Verify every public surface uses the same run semantics.",
  repository: { repositoryId: "repository_1" },
  preset: { presetId: "preset_1", presetVersion: 1 },
};

const CREATED = {
  kind: "CREATE_RUN" as const,
  record: {
    id: "record_1",
    projectId: "project_1",
    title: "Surface parity",
    revision: 1,
    runIds: ["run_1"],
  },
  run: {
    id: "run_1",
    coordinationRecordId: "record_1",
    state: "QUEUED" as const,
    goal: REQUEST.goal,
    repositoryMode: "INSPECT_ONLY" as const,
    repositoryAssurance: "ADVISORY" as const,
    revision: 1,
    attemptIds: ["attempt_1"],
  },
  attempt: {
    id: "attempt_1",
    runId: "run_1",
    state: "PENDING" as const,
    revision: 1,
  },
};

describe("Foundation public run surface", () => {
  test("strict public DTOs reject authority, runner, permit, session, and local-path input", () => {
    expect(PublicCreateRunRequestSchema.safeParse(REQUEST).success).toBeTrue();
    for (const forbidden of [
      { actor: ACTOR },
      { sessionId: "session_1" },
      { runnerId: "runner_1" },
      { permit: "clear-permit" },
      { localPath: "/Users/alice/work" },
    ]) {
      expect(
        PublicCreateRunRequestSchema.safeParse({ ...REQUEST, ...forbidden }).success,
      ).toBeFalse();
    }
    expect(PublicRunResultSchema.parse(CREATED)).toEqual(CREATED);
    expect(JSON.stringify(PublicRunResultSchema.parse(CREATED))).not.toContain("runner_1");
  });

  test("actual Hono browser mutations require session, exact origin, CSRF, and JSON", async () => {
    const app = createFoundationHttpApp({
      configuredOrigin: "https://collab.example",
      authentication: {
        async authenticateBrowser(request) {
          return request.headers.get("cookie") === "collab_session=session_1.proof_1"
            ? { ok: true, value: ACTOR }
            : {
                ok: false,
                error: {
                  code: "SESSION_REQUIRED",
                  message: "Member session is required.",
                  retry: "NEVER",
                },
              };
        },
        async authenticateDevice() {
          throw new Error("browser test must not use device authentication");
        },
        verifyBrowserMutation(request) {
          return (
            request.headers.get("origin") === "https://collab.example" &&
            request.headers.get("x-collab-csrf") === "csrf_1" &&
            request.headers.get("content-type") === "application/json"
          );
        },
      },
      runs: {
        async create(actor, input) {
          expect(actor).toEqual(ACTOR);
          expect(input).toEqual(REQUEST);
          return { ok: true, value: CREATED };
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
      },
    });

    const request = (headers: Record<string, string>) =>
      app.request("/api/v1/runs", {
        method: "POST",
        headers,
        body: JSON.stringify(REQUEST),
      });

    expect(
      (
        await request({
          origin: "https://collab.example",
          "content-type": "application/json",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request({
          cookie: "collab_session=session_1.proof_1",
          origin: "https://evil.example",
          "x-collab-csrf": "csrf_1",
          "content-type": "application/json",
        })
      ).status,
    ).toBe(403);
    const accepted = await request({
      cookie: "collab_session=session_1.proof_1",
      origin: "https://collab.example",
      "x-collab-csrf": "csrf_1",
      "content-type": "application/json",
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, value: CREATED });
  });
});
