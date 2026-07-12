import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readServerEnvironment } from "../shared/environment.ts";
import { createProductionServer } from "./adapters/wss/production-bootstrap.ts";
import { createApp } from "./app.ts";
import { createProductionComposition } from "./dependencies.ts";
import { assertNoIncompleteRestore } from "./operations/restore.ts";
import { createBetterAuthRebindCommand } from "./commands/better-auth-rebind.ts";
import { openDatabase } from "./db/connection.ts";
import { migrate } from "./db/migrate.ts";

const environment = readServerEnvironment(Bun.env);
const command = Bun.argv[2];

if (import.meta.main && command === "auth" && Bun.argv[3] === "rebind") {
  const memberIndex = Bun.argv.indexOf("--member");
  const memberId = memberIndex >= 0 ? Bun.argv[memberIndex + 1] : undefined;
  if (!memberId || !environment.bootstrapSecretFile) {
    console.error("AUTH_REBIND_ARGUMENTS_INVALID");
    process.exit(1);
  }
  const database = openDatabase(join(environment.dataDir, "collab.sqlite"));
  migrate(database);
  const result = createBetterAuthRebindCommand({
    database,
    invocationMode: "OFFLINE_CONTAINER",
    mountedBootstrapSecret: readFileSync(environment.bootstrapSecretFile, "utf8").trim(),
    publicBaseUrl: environment.publicBaseUrl,
    clock: () => Math.floor(Date.now() / 1_000),
    id: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
  }).generate({ memberId });
  database.close();
  if (!result.ok) {
    console.error(result.error.code);
    process.exit(1);
  }
  console.log(JSON.stringify(result.value));
  process.exit(0);
}

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
  : await createProductionComposition(environment, {
      docsRoot: "./docs",
      webRoot: environment.mode === "production" ? "./dist/web" : undefined,
    });

export default server;
