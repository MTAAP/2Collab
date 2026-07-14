import { expect, test } from "@playwright/test";

test("authors and executes Implementation -> reviews -> conditional Fix -> Terminal", async ({
  page,
}) => {
  await page.goto("/workflows/journey");
  await expect(page.getByRole("heading", { name: "Bounded Automation Journey" })).toBeVisible();
  await page.getByRole("button", { name: "Publish version" }).click();
  await page.getByRole("button", { name: "Bind exact presets" }).click();
  await page.getByRole("button", { name: "Start workflow" }).click();
  await expect(page.getByTestId("workflow-terminal")).toHaveText("COMPLETED");
  await expect(page.getByTestId("fix-run-count")).toHaveText("1");
  await expect(page.getByRole("button", { name: "Open implementation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open claude-review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open codex-review" })).toBeVisible();
});

test("live canonical real PR remains blocked without approved resources", async ({ page }) => {
  await page.goto("/workflows/journey");
  await expect(page.getByTestId("live-proof-status")).toHaveText("BLOCKED");
});
