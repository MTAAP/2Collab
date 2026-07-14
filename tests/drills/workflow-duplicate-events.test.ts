import { expect, test } from "bun:test";
import { workflowDigest } from "../../src/server/modules/workflows/idempotency.ts";

test("duplicate workflow events retain a stable semantic digest", () => {
  const event = { eventId: "event_1", result: { key: "CLEAN" } };
  expect(workflowDigest(event)).toBe(workflowDigest({ ...event }));
});
