import { readServerEnvironment } from "../shared/environment.ts";
import { createProductionServer } from "./adapters/wss/production-bootstrap.ts";
import { createApp } from "./app.ts";
import { createServerDependencies } from "./dependencies.ts";
import { assertNoIncompleteRestore } from "./operations/restore.ts";

const environment = readServerEnvironment(Bun.env);
const command = Bun.argv[2];

if (import.meta.main && command && command !== "serve") {
  console.error(`Unknown server command: ${command}`);
  process.exit(1);
}

const restoreState = await assertNoIncompleteRestore(environment.dataDir);
if (!restoreState.ok) throw new Error(restoreState.error.code);

const app = createApp(undefined, {
  docsRoot: "./docs",
  webRoot: environment.mode === "production" ? "./dist/web" : undefined,
});

const compositionModule = environment.runnerCompositionModule;
const server = compositionModule
  ? await (async () => {
      await import(compositionModule);
      return createProductionServer(environment, app);
    })()
  : await createServerDependencies(environment, {
      docsRoot: "./docs",
      webRoot: environment.mode === "production" ? "./dist/web" : undefined,
    });

export default server;
