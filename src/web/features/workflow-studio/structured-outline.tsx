import type { WorkflowDefinition } from "../../../shared/contracts/workflow.ts";

export function StructuredWorkflowOutline({
  definition,
  select,
}: Readonly<{ definition: WorkflowDefinition; select(key: string): void }>) {
  return (
    <nav aria-label="Workflow structure">
      <ol>
        {definition.nodes.map((node) => (
          <li key={node.key}>
            <button
              type="button"
              onClick={() => select(node.key)}
              aria-label={`${node.kind} ${node.key}`}
            >
              {node.kind} {node.key}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
