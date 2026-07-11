import { createApp } from "./app.ts";
import { readServerEnvironment } from "../shared/environment.ts";
import type { Hono } from "hono";

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

export default {
  fetch: app.fetch,
  hostname: environment.hostname,
  port: environment.port,
};
