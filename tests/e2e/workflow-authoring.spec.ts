import { expect, test } from "@playwright/test";

test("workflow authoring exposes a keyboard-operable synchronized outline", async ({ page }) => {
  await page.goto("/workflows/new");
  await expect(page.getByRole("heading", { name: "Workflow Studio" })).toBeVisible();
  const outline = page.getByRole("navigation", { name: "Workflow structure" });
  await outline.getByRole("button", { name: "AGENT_RUN implement" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Node inspector" })).toContainText("implement");
  await expect(page.getByRole("status", { name: "Workflow valid" })).toBeVisible();
  await expect(page.locator("[data-react-flow-derived='true']")).toBeVisible();
});
