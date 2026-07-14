import {
  preflightGitHubApp,
  readApprovedGitHubLiveConfiguration,
} from "../src/server/adapters/github/live-preflight.ts";

const configuration = await readApprovedGitHubLiveConfiguration(Bun.env);
if (!configuration.ok) {
  console.error(configuration.error.code);
  process.exit(1);
}
const result = await preflightGitHubApp(configuration.value);
if (!result.ok) {
  console.error(result.error.code);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, value: result.value }, null, 2));
