import {
  WorkflowStepResultSchema,
  type WorkflowStepResult,
} from "../../../shared/contracts/workflow-results.ts";

export function validateStepResult(value: unknown): WorkflowStepResult {
  const parsed = WorkflowStepResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("WORKFLOW_RESULT_CONTRACT_VIOLATION");
  return parsed.data;
}
