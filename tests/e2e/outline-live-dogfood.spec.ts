import { expect, test } from "@playwright/test";
test("requires an explicitly approved disposable Outline workspace", async () => {
  test.skip(process.env.COLLAB_LIVE_OUTLINE !== "1", "live Outline is not authorized");
  expect(process.env.COLLAB_LIVE_OUTLINE_WORKSPACE_ID).toBeTruthy();
  expect(process.env.COLLAB_LIVE_OUTLINE_APPROVAL_ID).toBeTruthy();
});
