import { expect, test } from "@playwright/test";

test("Inbox and Command Center are deduplicated read-only projections", async ({ page }) => {
  await page.route("**/api/v1/inbox", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        value: [
          {
            subjectKey: "ISSUE:101:42",
            safeSummary: "GitHub connector needs attention",
            category: "WARNING",
            unread: true,
          },
        ],
      }),
    }),
  );
  await page.route("**/api/v1/command-center", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        value: [
          {
            subjectKey: "ISSUE:101:42",
            summary: "GitHub connector needs attention",
            lane: "NEEDS_ATTENTION",
            draggable: false,
          },
        ],
      }),
    }),
  );
  await page.goto("/inbox");
  await expect(page.getByText("GitHub connector needs attention")).toBeVisible();
  await page.goto("/command-center");
  const card = page
    .getByRole("heading", { name: "GitHub connector needs attention" })
    .locator("..");
  await expect(card).not.toHaveAttribute("draggable", "true");
});
