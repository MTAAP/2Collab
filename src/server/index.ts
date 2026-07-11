import { readServerEnvironment } from "../shared/environment.ts";
import { createProductionServer } from "./adapters/wss/production-bootstrap.ts";
import { createApp } from "./app.ts";
import { assertNoIncompleteRestore } from "./operations/restore.ts";

const environment = readServerEnvironment(Bun.env);
const restoreState = await assertNoIncompleteRestore(environment.dataDir);
if (!restoreState.ok) throw new Error(restoreState.error.code);
if (!environment.runnerCompositionModule) throw new Error("RUNNER_COMPOSITION_MODULE_REQUIRED");
await import(environment.runnerCompositionModule);

export default await createProductionServer(
  environment,
  createApp({
    docsRoot: "./docs",
    webRoot: environment.mode === "production" ? "./dist/web" : undefined,
  }),
);
