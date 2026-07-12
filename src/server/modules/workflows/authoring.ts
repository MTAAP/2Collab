import type { Result } from "../../../shared/contracts/result.ts";
import type { WorkflowDraft } from "../../../shared/contracts/workflow.ts";
import type { SaveWorkflowDraft } from "./drafts.ts";

export type WorkflowAuthoringOperations = Readonly<{
  save(command: SaveWorkflowDraft): Promise<Result<WorkflowDraft>>;
}>;

export function createWorkflowAuthoringOperations(
  dependencies: Readonly<{
    saveDraft(command: SaveWorkflowDraft): Promise<Result<WorkflowDraft>>;
  }>,
): WorkflowAuthoringOperations {
  return { save: dependencies.saveDraft };
}
