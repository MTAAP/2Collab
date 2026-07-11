import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createFoundationHttpApp,
  type FoundationHttpDependencies,
} from "../../src/server/adapters/http/app.ts";
import { domainHttpStatus } from "../../src/server/adapters/http/domain-results.ts";
import { createMcpHttpHandler } from "../../src/server/adapters/mcp/http.ts";
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
  test("HTTP status mapping is closed instead of inferring meaning from error substrings", () => {
    expect(domainHttpStatus("RUN_NOT_FOUND")).toBe(404);
    expect(domainHttpStatus("RUN_TERMINAL")).toBe(409);
    expect(domainHttpStatus("INVENTED_NOT_FOUND_CONFLICT")).toBe(400);
  });

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
    expect(
      PublicCreateRunRequestSchema.safeParse({
        ...REQUEST,
        repository: { repositoryId: "repository_1", intendedBranch: "--upload-pack=evil" },
      }).success,
    ).toBeFalse();
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
      rateLimits: { allow: () => true },
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
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toEqual({ ok: true, value: CREATED });
  });

  test("route-owned browser security rejects wrong origins and mixed authentication modes", async () => {
    const app = createFoundationHttpApp({
      configuredOrigin: "https://collab.example",
      authentication: {
        async authenticateBrowser() {
          return { ok: true, value: ACTOR };
        },
        async authenticateDevice() {
          return { ok: true, value: ACTOR };
        },
        verifyBrowserMutation() {
          return true;
        },
      },
      rateLimits: { allow: () => true },
      runs: {
        async create() {
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
    const post = (headers: Record<string, string>) =>
      app.request("/api/v1/runs", {
        method: "POST",
        headers,
        body: JSON.stringify(REQUEST),
      });
    const browserHeaders = {
      cookie: "collab_session=session_1.proof_1",
      origin: "https://evil.example",
      "x-collab-csrf": "csrf_1",
      "content-type": "application/json",
    };
    expect((await post(browserHeaders)).status).toBe(403);
    expect(
      (
        await post({
          ...browserHeaders,
          origin: "https://collab.example",
          authorization: "DPoP device-token-that-must-not-mix-with-a-cookie",
          dpop: "proof",
          "dpop-nonce": "nonce",
        })
      ).status,
    ).toBe(401);
  });

  test("injected rate limiting and bounded JSON parsing fail before the operation", async () => {
    let operations = 0;
    const app = createFoundationHttpApp({
      configuredOrigin: "https://collab.example",
      authentication: {
        async authenticateBrowser() {
          return { ok: true, value: ACTOR };
        },
        async authenticateDevice() {
          return { ok: true, value: ACTOR };
        },
        verifyBrowserMutation() {
          return true;
        },
      },
      rateLimits: {
        allow(input) {
          return input.path !== "/api/v1/runs" || input.actorId !== "member_1";
        },
      },
      runs: {
        async create() {
          operations += 1;
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
    const response = await app.request("/api/v1/runs", {
      method: "POST",
      headers: {
        authorization: "DPoP device-token-that-is-at-least-thirty-two-bytes",
        dpop: "proof",
        "dpop-nonce": "nonce",
        "content-type": "application/json",
      },
      body: JSON.stringify(REQUEST),
    });
    expect(response.status).toBe(429);
    expect(operations).toBe(0);
  });

  test("create returns 201, permits only UTF-8 JSON parameters, and emits bounded security headers", async () => {
    const app = createFoundationHttpApp({
      configuredOrigin: "https://collab.example",
      authentication: {
        async authenticateBrowser() {
          return { ok: true, value: ACTOR };
        },
        async authenticateDevice() {
          return { ok: true, value: ACTOR };
        },
        verifyBrowserMutation() {
          return true;
        },
      },
      rateLimits: { allow: () => true },
      runs: {
        async create() {
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
    const post = (contentType: string, contentLength?: string) =>
      app.request("/api/v1/runs", {
        method: "POST",
        headers: {
          authorization: "DPoP device-token-that-is-at-least-thirty-two-bytes",
          dpop: "proof",
          "dpop-nonce": "nonce",
          "content-type": contentType,
          ...(contentLength ? { "content-length": contentLength } : {}),
        },
        body: JSON.stringify(REQUEST),
      });
    expect((await post("application/json", "-1")).status).toBe(400);
    expect((await post("application/json", "1.5")).status).toBe(400);
    expect((await post("application/json; profile=custom")).status).toBe(415);
    const accepted = await post("application/json; charset=utf-8");
    expect(accepted.status).toBe(201);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    const csp = accepted.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
  });

  test("installed SDK Streamable HTTP calls the same canonical run tool over actual Hono", async () => {
    const dependencies: Omit<FoundationHttpDependencies, "mcp"> = {
      configuredOrigin: "https://collab.example",
      authentication: {
        async authenticateBrowser() {
          throw new Error("MCP must not use browser authentication");
        },
        async authenticateDevice(request) {
          return request.headers.get("authorization") ===
            "DPoP access_token_12345678901234567890" &&
            request.headers.get("dpop") === "signed-proof" &&
            request.headers.get("dpop-nonce") === "nonce_1"
            ? { ok: true as const, value: ACTOR }
            : {
                ok: false as const,
                error: {
                  code: "DEVICE_AUTHENTICATION_REQUIRED",
                  message: "Device authentication is required.",
                  retry: "REFRESH" as const,
                },
              };
        },
        verifyBrowserMutation() {
          throw new Error("MCP must not use browser mutation proofs");
        },
      },
      rateLimits: { allow: () => true },
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
    };
    const app = createFoundationHttpApp({
      ...dependencies,
      mcp: createMcpHttpHandler(dependencies),
    });
    const transport = new StreamableHTTPClientTransport(new URL("https://collab.example/mcp"), {
      requestInit: {
        headers: {
          authorization: "DPoP access_token_12345678901234567890",
          dpop: "signed-proof",
          "dpop-nonce": "nonce_1",
        },
      },
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    });
    const client = new Client({ name: "surface-parity", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
        "collab_run_create",
      );
      const called = await client.callTool({ name: "collab_run_create", arguments: REQUEST });
      expect(called.structuredContent).toEqual({ ok: true, value: CREATED });
    } finally {
      await client.close();
    }
  });
});
