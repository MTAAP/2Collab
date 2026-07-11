import { expect, test } from "@playwright/test";

test("one runtime plans and a distinct runtime consumes the portable artifact", async ({
  page,
}) => {
  await page.goto("/workflows/planning");
  await expect(page.getByRole("heading", { name: "Portable Planning Workflow" })).toBeVisible();
  await expect(page.getByText("Claude · runner-a · Orca")).toBeVisible();
  await page.getByRole("button", { name: "Approve plan" }).click();
  await expect(page.getByText("Codex · runner-b · Native")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Plan Artifact" })).toBeVisible();
});
