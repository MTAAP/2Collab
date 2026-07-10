import { createApp } from "./app.ts";
import { readServerEnvironment } from "../shared/environment.ts";

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
