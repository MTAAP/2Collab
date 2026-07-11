import { expect, test } from "bun:test";
import { aggregateWorkflowUsage } from "../../../src/server/modules/telemetry/workflow-usage.ts";

test("workflow aggregation remains a projection over immutable attempts and gates", () => {
  const attempts = Object.freeze([
    Object.freeze({ inputUnits: 10, outputUnits: 5, runtimeMs: 100, category: "TOKENS" as const }),
  ]);
  const gates = Object.freeze([Object.freeze({ durationMs: 20 })]);
  expect(aggregateWorkflowUsage(attempts, gates)).toMatchObject({
    coverage: { status: "COMPLETE" },
    runtimeMs: 100,
    gateMs: 20,
  });
  expect(attempts[0]).toEqual({
    inputUnits: 10,
    outputUnits: 5,
    runtimeMs: 100,
    category: "TOKENS",
  });
});
