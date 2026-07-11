import { expect, test } from "bun:test";
import { expireWorkflow } from "../../../src/server/modules/workflows/deadlines.ts";

test("expiry is atomic and terminal states remain immutable", () => {
  const calls: string[] = [];
  const transaction = {
    lockExecution: () => ({ id: "workflow_1", state: "PAUSED" as const, absoluteDeadlineAt: 100 }),
    invalidateLaunchIntents: () => calls.push("INVALIDATE"),
    transition: () => calls.push("FAILED"),
    enqueueOrdinaryRunCancellations: () => calls.push("CANCEL"),
  };
  expect(expireWorkflow(transaction, "workflow_1", 100)).toMatchObject({ state: "FAILED" });
  expect(calls).toEqual(["INVALIDATE", "FAILED", "CANCEL"]);
});
