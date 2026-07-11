import { readFile } from "node:fs/promises";
import {
  validateLivePlaywrightReport,
  validateOutlineEvidence,
} from "../tests/evidence/outline-matrix.ts";
const command = process.argv[2] ?? "validate";
const path =
  process.argv[3] ??
  (command === "validate" ? "docs/evidence/outline/LOCAL-EVIDENCE.json" : undefined);
if (!path || (command !== "validate" && command !== "validate-live")) {
  console.error("usage: bun run outline:evidence <validate|validate-live> <json>");
  process.exit(2);
}
const input = JSON.parse(await readFile(path, "utf8"));
const result =
  command === "validate-live"
    ? !process.env.COLLAB_LIVE_OUTLINE_WORKSPACE_ID ||
      !process.env.COLLAB_LIVE_OUTLINE_APPROVAL_ID ||
      !process.env.COLLAB_OUTLINE_BUILD_ID
      ? { valid: false, reason: "BLOCKED_ENV" }
      : validateLivePlaywrightReport(input, {
          buildId: process.env.COLLAB_OUTLINE_BUILD_ID,
          workspaceId: process.env.COLLAB_LIVE_OUTLINE_WORKSPACE_ID,
          approvalId: process.env.COLLAB_LIVE_OUTLINE_APPROVAL_ID,
        })
    : validateOutlineEvidence(input);
console.log(JSON.stringify(result, null, 2));
process.exit(result.valid ? 0 : 1);
