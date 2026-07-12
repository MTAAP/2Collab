import type { Result } from "../../shared/contracts/result.ts";
import type { WorkflowDraft } from "../../shared/contracts/workflow.ts";
import type { WorkflowAuthoringOperations } from "../../server/modules/workflows/authoring.ts";
import type { SaveWorkflowDraft } from "../../server/modules/workflows/drafts.ts";

export async function workflowCommand(
  args: readonly string[],
  operations: WorkflowAuthoringOperations,
): Promise<Result<WorkflowDraft>> {
  if (args.length !== 2 || args[0] !== "save-draft") throw new Error("WORKFLOW_ARGUMENTS_INVALID");
  let command: SaveWorkflowDraft;
  try {
    command = JSON.parse(args[1] as string) as SaveWorkflowDraft;
  } catch {
    throw new Error("WORKFLOW_ARGUMENTS_INVALID");
  }
  return operations.save(command);
}
