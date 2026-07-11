import { expect, test } from "bun:test";
import { aggregateWorkflowUsage } from "../../../src/server/modules/telemetry/workflow-usage.ts";

test("labels partial totals and separates gate time", () => {
  expect(
    aggregateWorkflowUsage(
      [
        { inputUnits: 100, outputUnits: 20, runtimeMs: 1_000, category: "TOKENS" },
        { inputUnits: "UNKNOWN", outputUnits: "UNKNOWN", runtimeMs: 2_000, category: "TOKENS" },
      ],
      [{ durationMs: 400 }],
    ),
  ).toEqual({
    coverage: { knownAttempts: 1, totalAttempts: 2, status: "PARTIAL" },
    known: { inputUnits: 100, outputUnits: 20, category: "TOKENS" },
    runtimeMs: 3_000,
    gateMs: 400,
  });
});

test("unknown usage is never treated as zero and incompatible categories do not merge", () => {
  expect(() =>
    aggregateWorkflowUsage(
      [
        { inputUnits: 100, outputUnits: 20, runtimeMs: 1_000, category: "TOKENS" },
        { inputUnits: 2, outputUnits: 1, runtimeMs: 1_000, category: "REQUESTS" },
      ],
      [],
    ),
  ).toThrow("WORKFLOW_USAGE_CATEGORY_INCOMPATIBLE");
  const unknown = aggregateWorkflowUsage(
    [{ inputUnits: "UNKNOWN", outputUnits: "UNKNOWN", runtimeMs: 10, category: "TOKENS" }],
    [],
  );
  expect(unknown.known.inputUnits).toBe(0);
  expect(unknown.coverage.status).toBe("PARTIAL");
  expect(unknown).not.toHaveProperty("cost");
});
