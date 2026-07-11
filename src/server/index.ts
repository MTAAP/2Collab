import { readServerEnvironment } from "../shared/environment.ts";
import { createProductionServer } from "./adapters/wss/production-bootstrap.ts";
import { createApp } from "./app.ts";

const environment = readServerEnvironment(Bun.env);
if (!environment.runnerCompositionModule) throw new Error("RUNNER_COMPOSITION_MODULE_REQUIRED");
await import(environment.runnerCompositionModule);

export default await createProductionServer(
  environment,
  createApp({
    docsRoot: "./docs",
    webRoot: environment.mode === "production" ? "./dist/web" : undefined,
  }),
);
