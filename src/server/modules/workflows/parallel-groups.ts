import type { TeamRunTemplateVersion } from "../../../shared/contracts/templates.ts";
import type { WorkflowDefinition } from "../../../shared/contracts/workflow.ts";

export function prepareParallelGroup(
  definition: WorkflowDefinition,
  splitKey: string,
  templates: ReadonlyMap<string, TeamRunTemplateVersion>,
): readonly string[] {
  const split = definition.nodes.find((node) => node.key === splitKey);
  if (split?.kind !== "PARALLEL_SPLIT") throw new Error("WORKFLOW_PARALLEL_GROUP_INVALID");
  if (
    split.branchKeys.length > definition.maximumParallelBranches ||
    split.branchKeys.some((key) => {
      const branch = definition.nodes.find((node) => node.key === key);
      return (
        branch?.kind !== "AGENT_RUN" ||
        templates.get(branch.runTemplateVersionId)?.definition.repositoryMode !== "INSPECT_ONLY"
      );
    })
  )
    throw new Error("WORKFLOW_PARALLEL_MUTATION_FORBIDDEN");
  return split.branchKeys;
}
