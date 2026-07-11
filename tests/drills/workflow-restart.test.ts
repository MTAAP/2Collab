import { expect, test } from "bun:test";
import { workflowIdempotencyKey } from "../../src/server/modules/workflows/idempotency.ts";

test("restart preserves the same step idempotency identity", () => {
  expect(workflowIdempotencyKey("workflow_1", "review-2")).toBe(
    workflowIdempotencyKey("workflow_1", "review-2"),
  );
});
