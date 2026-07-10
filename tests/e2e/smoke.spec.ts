import { expect, test } from "@playwright/test";

test("renders the implementation foundation at desktop and mobile widths", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/2Collab/);
  await expect(page.getByRole("heading", { level: 1, name: "2Collab" })).toBeVisible();
  await expect(page.getByText("Repository foundation ready")).toBeVisible();
  await expect(page.getByRole("link", { name: "Start implementing" })).toHaveAttribute(
    "href",
    "/docs/START-HERE.md",
  );

  await page.setViewportSize({ height: 844, width: 390 });
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBe(false);

  const documentResponse = await page.request.get("/docs/START-HERE.md");
  expect(documentResponse.status()).toBe(200);
  expect(await documentResponse.text()).toContain("# Start Here");

  await page.getByRole("link", { name: "Start implementing" }).click();
  await expect(page).toHaveURL(/\/docs\/START-HERE\.md$/);
});
