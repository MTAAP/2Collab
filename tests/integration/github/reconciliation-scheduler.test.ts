import { expect, test } from "bun:test";
import { createGitHubReconciliationScheduler } from "../../../src/server/modules/github-coordination/reconciliation-scheduler.ts";

test("scheduler resumes configured scopes and stops cleanly", async () => {
  let calls = 0;
  const scheduler = createGitHubReconciliationScheduler({
    clock: () => 100,
    intervalMs: 1_000,
    maximumBackoffMs: 8_000,
    scopes: () => [{ projectId: "project_1" as never, connectorId: "github_1" as never, connectorEpoch: 1, references: ["ISSUE:101:1"], operations: ["INSPECT"] }],
    reconcile: async () => { calls += 1; return { ok: true, value: {} }; },
    setTimer: ((_callback: () => void, _delay?: number) => 1) as never,
    clearTimer: (() => undefined) as never,
  });
  await scheduler.runNow();
  expect(calls).toBe(1);
  scheduler.stop();
  expect(scheduler.state()).toMatchObject({ stopped: true, running: false });
});
