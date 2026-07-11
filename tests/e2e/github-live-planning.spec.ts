import { test } from "@playwright/test";
test("github-live-planning", async () => {
  test.skip(
    process.env.COLLAB_LIVE_GITHUB !== "1" || !process.env.COLLAB_GITHUB_APPROVAL_ID,
    "LIVE_GITHUB_NOT_AUTHORIZED",
  );
});
