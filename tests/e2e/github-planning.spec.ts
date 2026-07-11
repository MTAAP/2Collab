import { expect, test } from "@playwright/test";

test("selected GitHub planning projects remain read-only projections", async ({ page }) => {
  await page.route("**/api/v1/projects/project_1/github/planning", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        value: [
          {
            kind: "ISSUE",
            repositoryId: "101",
            number: 42,
            title: "Ship GitHub coordination",
            state: "OPEN",
            labels: ["in-progress"],
            assignees: ["tim"],
            milestoneNumber: 1,
            commentCount: 2,
          },
          {
            kind: "PROJECT",
            projectNodeId: "PVT_1",
            title: "Delivery",
            itemCount: 1,
            unsupportedRepositoryItems: 1,
            fields: [],
          },
        ],
      }),
    });
  });
  await page.goto("/github");
  const column = page.getByRole("region", { name: "In progress" });
  await expect(column).toContainText("Issue 42: Ship GitHub coordination");
  await expect(page.getByText("1 out-of-scope items redacted")).toBeVisible();
  await expect(page.getByRole("region", { name: "In progress" })).not.toHaveAttribute(
    "draggable",
    "true",
  );
});
