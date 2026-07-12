import { expect, test } from "./fixtures.ts";

test("triage remains open after merge and closes only after GitHub reconciliation", async ({
  page,
}) => {
  let issueState: "OPEN" | "CLOSED" = "OPEN";
  await page.route("**/api/v1/projects/project_1/github/planning", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        value: [
          {
            kind: "ISSUE",
            repositoryId: "101",
            number: 42,
            title: "Deliver coordination",
            state: issueState,
            labels: ["in-progress"],
            assignees: ["tim"],
            commentCount: 1,
          },
          {
            kind: "PULL_REQUEST",
            repositoryId: "101",
            number: 7,
            title: "Delivery",
            state: "CLOSED",
            draft: false,
            merged: true,
            headSha: "a".repeat(40),
            baseRef: "main",
            labels: [],
            assignees: [],
          },
        ],
      }),
    }),
  );
  await page.goto("/github");
  await expect(page.getByText("OPEN", { exact: true })).toBeVisible();
  issueState = "CLOSED";
  await page.reload();
  await expect(page.getByText("CLOSED", { exact: true }).first()).toBeVisible();
});
