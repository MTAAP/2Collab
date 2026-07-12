import { expect, test } from "bun:test";
import type { ResultRouterNode } from "../../../src/shared/contracts/workflow.ts";
import { routeTypedResult } from "../../../src/server/modules/workflows/conditions.ts";

const router: ResultRouterNode = {
  kind: "RESULT_ROUTER",
  key: "review_result",
  sourceStepKey: "review",
  routes: { MAJOR_FINDING: "fix", CLEAN: "terminal", MINOR_ONLY: "terminal" },
  fallbackTargetKey: "human-review",
};

test.each([
  ["MAJOR_FINDING", "fix"],
  ["CLEAN", "terminal"],
  ["MINOR_ONLY", "terminal"],
  ["RESULT_CONTRACT_VIOLATION", "human-review"],
])("routes %s to %s without prose inspection", (key, targetKey) => {
  expect(
    routeTypedResult(router, {
      stepOccurrenceId: "review-1",
      runId: "run-review",
      key,
      artifacts: [],
    }).targetKey,
  ).toBe(targetKey);
});
