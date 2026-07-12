import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

test("completes a disposable live Outline API-token provider journey", async () => {
  test.skip(process.env.COLLAB_LIVE_OUTLINE !== "1", "live Outline is not authorized");
  test.skip(
    !process.env.OUTLINE_BASE_URL || !process.env.OUTLINE_TOKEN_FILE,
    "token smoke is not configured",
  );
  const output = execFileSync("bun", ["run", "outline:live-smoke"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  const evidence = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  expect(evidence).toMatchObject({
    ok: true,
    searchConfirmed: true,
    readConfirmed: true,
    updateConfirmed: true,
    conflictConfirmed: true,
    cleanupConfirmed: true,
  });
});

test("records that API-token smoke is not delegated two-member acceptance", async () => {
  test.skip(
    process.env.COLLAB_LIVE_OUTLINE_TWO_MEMBER !== "1",
    "requires delegated OAuth identities for two distinct approved members",
  );
  expect(process.env.COLLAB_LIVE_OUTLINE_WORKSPACE_ID).toBeTruthy();
  expect(process.env.COLLAB_LIVE_OUTLINE_APPROVAL_ID).toBeTruthy();
  expect(process.env.COLLAB_LIVE_OUTLINE_MEMBER_IDS?.split(",")).toHaveLength(2);
});
