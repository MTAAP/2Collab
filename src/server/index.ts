import { createApp } from "./app.ts";
import { readServerEnvironment } from "../shared/environment.ts";
import type { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { createBunRunnerControlAdapter } from "./adapters/wss/bun-runner-control.ts";
import { createRunnerChannel } from "./adapters/wss/runner-channel.ts";

type RunnerControlComposition<Server> = Readonly<{
  fetch(request: Request, server: Server): Promise<Response | undefined | null>;
  websocket: Readonly<Record<string, unknown>>;
}>;

export function createServerEntrypoint<Server>(
  input: Readonly<{
    app: Hono;
    runnerControl: RunnerControlComposition<Server>;
    hostname: string;
    port: number;
  }>,
) {
  return {
    async fetch(request: Request, server: Server): Promise<Response | undefined> {
      const runner = await input.runnerControl.fetch(request, server);
      return runner === null ? input.app.fetch(request) : runner;
    },
    websocket: input.runnerControl.websocket,
    hostname: input.hostname,
    port: input.port,
  };
}

const environment = readServerEnvironment(Bun.env);
const app = createApp({
  docsRoot: "./docs",
  webRoot: environment.mode === "production" ? "./dist/web" : undefined,
});

const now = () => Date.now() / 1_000;
const runnerChannel = createRunnerChannel({
  now,
  messageId: () => `message_${randomBytes(24).toString("base64url")}`,
  loadCommitted: () => [],
});
const runnerControl = createBunRunnerControlAdapter({
  channel: runnerChannel,
  now,
  authority: {
    authenticateUpgrade: async () => ({
      ok: false,
      error: {
        code: "RUNNER_AUTHENTICATION_UNAVAILABLE",
        message: "Runner authentication is unavailable.",
        retry: "NEVER",
      },
    }),
  },
  secureTransport: (request) => new URL(request.url).protocol === "https:",
  createRouter: () => ({
    route: async () => ({ accepted: false, code: "RUNNER_CONTROL_UNAVAILABLE" }),
  }),
});

export default createServerEntrypoint({
  app,
  runnerControl,
  hostname: environment.hostname,
  port: environment.port,
});
