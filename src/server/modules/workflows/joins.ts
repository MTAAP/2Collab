import type { JoinNode } from "../../../shared/contracts/workflow.ts";
import type { JoinState, WorkflowStepResult } from "../../../shared/contracts/workflow-results.ts";

export function evaluateJoin(join: JoinNode, state: JoinState, branch: WorkflowStepResult) {
  if (state.committedResultKey)
    return { state, cancelKeys: [] as string[], resultsByBranch: state.resultsByBranch };
  const branchKey = branch.stepOccurrenceId.replace(/-\d+$/, "");
  if (!join.branchKeys.includes(branchKey) || state.terminalBranchKeys.includes(branchKey))
    return { state, cancelKeys: [] as string[], resultsByBranch: state.resultsByBranch };
  const terminalBranchKeys = [...state.terminalBranchKeys, branchKey];
  const resultsByBranch = { ...(state.resultsByBranch ?? {}), [branchKey]: branch };
  const accepted = join.acceptedResultKeys.includes(branch.key);
  if (join.policy === "ANY" && accepted)
    return {
      state: { committedResultKey: branch.key, terminalBranchKeys, resultsByBranch },
      transition: { targetKey: branch.key },
      cancelKeys:
        join.remainderPolicy === "CANCEL_REMAINDER"
          ? join.branchKeys.filter((key) => !terminalBranchKeys.includes(key))
          : [],
      resultsByBranch,
    };
  if (join.policy === "ALL" && terminalBranchKeys.length === join.branchKeys.length)
    return {
      state: { committedResultKey: "ALL", terminalBranchKeys, resultsByBranch },
      transition: { targetKey: "ALL" },
      cancelKeys: [] as string[],
      resultsByBranch,
    };
  if (join.policy === "ANY" && terminalBranchKeys.length === join.branchKeys.length)
    return {
      state: { committedResultKey: "FALLBACK", terminalBranchKeys, resultsByBranch },
      transition: { targetKey: join.fallbackTargetKey },
      cancelKeys: [] as string[],
      resultsByBranch,
    };
  return {
    state: { terminalBranchKeys, resultsByBranch },
    cancelKeys: [] as string[],
    resultsByBranch,
  };
}
