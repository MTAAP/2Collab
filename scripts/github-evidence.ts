import { readFile } from "node:fs/promises";
import { validateGitHubEvidence } from "../tests/evidence/github-matrix.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
async function main() {
  const [command, reportPath] = process.argv.slice(2);
  if (command === "validate") {
    const input = JSON.parse(
      await readFile(reportPath ?? "docs/evidence/github/LOCAL-EVIDENCE.json", "utf8"),
    );
    const result = validateGitHubEvidence(input);
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exit(1);
    return;
  }
  if (command !== "validate-live" || !reportPath)
    fail("Usage: github-evidence <validate|validate-live> [json]");
  if (process.env.COLLAB_LIVE_GITHUB !== "1") fail("LIVE_GITHUB_NOT_AUTHORIZED");
  for (const name of [
    "COLLAB_GITHUB_INSTALLATION_ID",
    "COLLAB_GITHUB_REPOSITORY_ID",
    "COLLAB_GITHUB_PROJECT_ID",
    "COLLAB_GITHUB_APPROVAL_ID",
  ])
    if (!process.env[name] || !/^[A-Za-z0-9_-]{1,128}$/.test(process.env[name] ?? ""))
      fail(`LIVE_GITHUB_TARGET_INVALID:${name}`);
  if (!String(process.env.COLLAB_GITHUB_APPROVAL_ID).startsWith("approval_"))
    fail("LIVE_GITHUB_APPROVAL_INVALID");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const suites = JSON.stringify(report);
  if (report.errors?.length || !suites.includes("github-live-")) fail("LIVE_GITHUB_REPORT_INVALID");
  if (report.stats?.unexpected && report.stats.unexpected > 0) fail("LIVE_GITHUB_TEST_FAILED");
  console.log("Live GitHub evidence report validated.");
}
await main();
