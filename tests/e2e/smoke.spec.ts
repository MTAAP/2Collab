import { expect, test } from "./fixtures.ts";

test("renders the Foundation shell at desktop and mobile widths", async ({ page }) => {
  await page.goto("/runs");

  await expect(page).toHaveTitle(/2Collab/);
  await expect(page.getByRole("heading", { level: 1, name: "Agent runs" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();

  await page.setViewportSize({ height: 844, width: 390 });
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBe(false);

  await page.getByRole("button", { name: "New run" }).click();
  await expect(page.getByRole("dialog", { name: "New run" })).toBeVisible();
});
