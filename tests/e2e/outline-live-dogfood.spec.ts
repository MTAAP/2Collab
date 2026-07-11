import { expect, test } from "@playwright/test";
test("completes the approved disposable two-member Outline collaboration journey", async () => {
  test.skip(process.env.COLLAB_LIVE_OUTLINE !== "1", "live Outline is not authorized");
  expect(process.env.COLLAB_LIVE_OUTLINE_WORKSPACE_ID).toBeTruthy();
  expect(process.env.COLLAB_LIVE_OUTLINE_APPROVAL_ID).toBeTruthy();
  test.fail(
    true,
    "The live provider journey is not implemented; credentials alone cannot create PASS evidence.",
  );
});
