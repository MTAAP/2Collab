import { expect, test } from "./fixtures.ts";

const createdRun = {
  ok: true,
  value: {
    kind: "CREATE_RUN",
    record: {
      id: "record_1",
      projectId: "project_1",
      title: "Foundation work",
      revision: 1,
      runIds: ["run_1"],
    },
    run: {
      id: "run_1",
      coordinationRecordId: "record_1",
      state: "QUEUED",
      goal: "Implement the bounded Foundation slice.",
      repositoryMode: "INSPECT_ONLY",
      repositoryAssurance: "ADVISORY",
      revision: 1,
      attemptIds: ["attempt_1"],
    },
    attempt: { id: "attempt_1", runId: "run_1", state: "PENDING", revision: 1 },
  },
} as const;

test("Foundation run composition launches through the public browser DTO", async ({ page }) => {
  await page.route("**/api/v1/runs", async (route) => {
    const request = route.request();
    expect(request.method()).toBe("POST");
    expect(request.headers()).not.toHaveProperty("x-collab-csrf");
    expect(request.postDataJSON()).toEqual({
      idempotencyKey: expect.any(String),
      projectId: "project_1",
      coordination: { kind: "NEW", title: "Foundation work", sourceRefs: [] },
      goal: "Implement the bounded Foundation slice.",
      repository: { repositoryId: "repository_1" },
      preset: { presetId: "preset_1", presetVersion: 1 },
    });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(createdRun),
    });
  });
  await page.goto("/runs");
  await page.getByRole("button", { name: "New run" }).click();
  await page.getByRole("button", { name: "Launch run" }).click();

  await expect(page.getByText("run_1", { exact: true })).toBeVisible();
  await expect(page.getByText("QUEUED", { exact: true })).toBeVisible();
});

test("live state consumes only a committed public projection", async ({ page }) => {
  await page.route("**/api/v1/events", async (route) => {
    await route.fulfill({
      contentType: "text/event-stream",
      body: `event: projection\nid: 1\ndata: ${JSON.stringify({
        kind: "PROJECTION",
        cursor: 1,
        committed: true,
        projectId: "project_1",
        occurredAt: 1,
        data: { kind: "RUN_CHANGED", run: createdRun.value.run },
      })}\n\n`,
    });
  });
  await page.goto("/runs");
  await page.reload();

  await expect(page.getByText("Committed update 1")).toBeVisible();
});
