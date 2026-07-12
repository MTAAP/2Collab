import type { ResultRouterNode } from "../../../shared/contracts/workflow.ts";
import type { WorkflowStepResult } from "../../../shared/contracts/workflow-results.ts";

export function routeTypedResult(router: ResultRouterNode, result: WorkflowStepResult) {
  const targetKey = router.routes[result.key] ?? router.fallbackTargetKey;
  if (!targetKey) throw new Error("WORKFLOW_RESULT_FALLBACK_REQUIRED");
  return { sourceStepOccurrenceId: result.stepOccurrenceId, resultKey: result.key, targetKey };
}
