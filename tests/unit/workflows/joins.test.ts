import { describe, expect, test } from "bun:test";
import type { JoinNode } from "../../../src/shared/contracts/workflow.ts";
import { evaluateJoin } from "../../../src/server/modules/workflows/joins.ts";

const anyJoin: JoinNode = {
  kind: "JOIN",
  key: "review_join",
  branchKeys: ["claude-review", "codex-review"],
  policy: "ANY",
  acceptedResultKeys: ["CLEAN"],
  fallbackTargetKey: "human-review",
  remainderPolicy: "CANCEL_REMAINDER",
};
const result = (stepOccurrenceId: string, key: string) => ({
  stepOccurrenceId,
  runId: `run-${stepOccurrenceId}`,
  key,
  artifacts: [],
});

describe("typed joins", () => {
  test("ANY accepts one matching result and applies CANCEL_REMAINDER once", () => {
    const first = evaluateJoin(
      anyJoin,
      { terminalBranchKeys: [] },
      result("claude-review", "CLEAN"),
    );
    const raced = evaluateJoin(anyJoin, first.state, result("codex-review", "MAJOR_FINDING"));
    expect(first.transition?.targetKey).toBe("CLEAN");
    expect(first.cancelKeys).toEqual(["codex-review"]);
    expect(raced.transition).toBeUndefined();
  });

  test("ANY uses the typed fallback only after every branch is terminal", () => {
    const first = evaluateJoin(
      anyJoin,
      { terminalBranchKeys: [] },
      result("claude-review", "MINOR_ONLY"),
    );
    const last = evaluateJoin(anyJoin, first.state, result("codex-review", "RUN_FAILED"));
    expect(first.transition).toBeUndefined();
    expect(last.transition?.targetKey).toBe("human-review");
  });

  test("ALL emits one keyed artifact map after every distinct branch", () => {
    const join = { ...anyJoin, policy: "ALL" as const, remainderPolicy: undefined };
    const first = evaluateJoin(join, { terminalBranchKeys: [] }, result("claude-review", "CLEAN"));
    const duplicate = evaluateJoin(join, first.state, result("claude-review", "CLEAN"));
    const last = evaluateJoin(join, duplicate.state, result("codex-review", "MINOR_ONLY"));
    expect(duplicate.state.terminalBranchKeys).toEqual(["claude-review"]);
    expect(last.transition?.targetKey).toBe("ALL");
    expect(last.resultsByBranch?.["codex-review"]?.key).toBe("MINOR_ONLY");
  });
});
