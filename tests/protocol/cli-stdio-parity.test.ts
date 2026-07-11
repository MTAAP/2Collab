import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { PublicRunClient } from "../../src/cli/api-client.ts";
import { type CliIo, runCli } from "../../src/cli/command.ts";
import { createFoundationHttpApp } from "../../src/server/adapters/http/app.ts";
import type { PublicCreateRunRequest } from "../../src/shared/contracts/public-api.ts";

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

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) },
    stdout,
    stderr,
  };
}

function clientWithCreate(create: PublicRunClient["create"]): PublicRunClient {
  const unused = async () => {
    throw new Error("not exercised");
  };
  return {
    create,
    inspect: unused,
    cancel: unused,
    resume: unused,
    evidence: unused,
  } as PublicRunClient;
}

const START_ARGS = [
  "--project",
  "project_1",
  "--preset",
  "preset_1",
  "--preset-version",
  "1",
  "--goal",
  REQUEST.goal,
  "--repository",
  "repository_1",
  "--record-title",
  "Surface parity",
  "--idempotency-key",
  "launch_1",
  "--json",
] as const;

const BINARY = `/tmp/collab-task13-${process.pid}`;

beforeAll(async () => {
  const built = Bun.spawn(["bun", "build", "--compile", "src/cli/index.ts", "--outfile", BINARY], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([built.exited, new Response(built.stderr).text()]);
  if (exitCode !== 0) throw new Error(`compiled CLI build failed: ${stderr}`);
});

afterAll(async () => {
  await unlink(BINARY).catch(() => undefined);
});

function compiledFixture() {
  const app = createFoundationHttpApp({
    configuredOrigin: "http://localhost",
    authentication: {
      async authenticateBrowser() {
        throw new Error("compiled CLI must not use browser authentication");
      },
      async authenticateDevice(request) {
        return request.headers.get("authorization") === "DPoP access_token_12345678901234567890" &&
          request.headers.get("dpop") === "signed-proof" &&
          request.headers.get("dpop-nonce") === "nonce_1"
          ? {
              ok: true as const,
              value: {
                kind: "MEMBER" as const,
                memberId: "member_1" as never,
                sessionId: "device_1" as never,
                sessionProof: "device-authenticated-context-at-least-thirty-two-bytes",
              },
            }
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
        throw new Error("compiled CLI must not use browser mutation proofs");
      },
    },
    rateLimits: { allow: () => true },
    runs: {
      async create() {
        return { ok: true as const, value: CREATED };
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
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  return {
    environment: {
      NODE_ENV: "test",
      COLLAB_BASE_URL: `http://localhost:${server.port}`,
      COLLAB_DEVICE_ACCESS_TOKEN: "access_token_12345678901234567890",
      COLLAB_DPOP_PROOF: "signed-proof",
      COLLAB_DPOP_NONCE: "nonce_1",
    },
    server,
  };
}

describe("compiled CLI and stdio parity", () => {
  test("start and run are exact aliases with deterministic JSON and exit status", async () => {
    const calls: PublicCreateRunRequest[] = [];
    const runsApi = clientWithCreate(async (request) => {
      calls.push(request);
      return { ok: true as const, value: CREATED };
    });

    for (const command of ["start", "run"] as const) {
      const output = capture();
      const exitCode = await runCli([command, ...START_ARGS], output.io, {
        environment: {},
        runtimeVersion: "1.3.10",
        runsApi,
      });
      expect(exitCode).toBe(0);
      expect(output.stderr).toEqual([]);
      expect(output.stdout).toEqual([JSON.stringify({ ok: true, value: CREATED })]);
    }
    expect(calls).toEqual([REQUEST, REQUEST]);
  });

  test("usage and domain failures have stable distinct exit classes", async () => {
    const usage = capture();
    expect(
      await runCli(["start", "--json"], usage.io, {
        environment: {},
        runtimeVersion: "1.3.10",
        runsApi: {} as PublicRunClient,
      }),
    ).toBe(2);
    expect(usage.stderr).toEqual(["RUN_ARGUMENTS_INVALID"]);

    const domain = capture();
    const runsApi = clientWithCreate(async () => {
      return {
        ok: false as const,
        error: { code: "RUN_TERMINAL", message: "Run is terminal.", retry: "NEVER" as const },
      };
    });
    expect(
      await runCli(["run", ...START_ARGS], domain.io, {
        environment: {},
        runtimeVersion: "1.3.10",
        runsApi,
      }),
    ).toBe(1);
    expect(domain.stdout).toEqual([
      JSON.stringify({
        ok: false,
        error: { code: "RUN_TERMINAL", message: "Run is terminal.", retry: "NEVER" },
      }),
    ]);
  });

  test("the compiled main executable exercises the real HTTP surface for both aliases", async () => {
    const fixture = compiledFixture();
    try {
      for (const command of ["start", "run"] as const) {
        const process = Bun.spawn([BINARY, command, ...START_ARGS], {
          env: fixture.environment,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          process.exited,
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
        ]);
        expect(exitCode).toBe(0);
        expect(stderr).toBe("");
        expect(stdout.trim()).toBe(JSON.stringify({ ok: true, value: CREATED }));
      }
    } finally {
      fixture.server.stop(true);
    }
  });

  test("collab mcp serves only SDK stdio frames and proxies the shared public tools", async () => {
    const fixture = compiledFixture();
    const transport = new StdioClientTransport({
      command: BINARY,
      args: ["mcp"],
      env: fixture.environment,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client({ name: "compiled-stdio-parity", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
        "collab_run_create",
      );
      const called = await client.callTool({ name: "collab_run_create", arguments: REQUEST });
      expect(called.structuredContent).toEqual({ ok: true, value: CREATED });
    } finally {
      await client.close();
      fixture.server.stop(true);
    }
    expect(stderr).toBe("");
  });
});
