import type { WorkflowNode } from "../../../shared/contracts/workflow.ts";

type HumanDecisionNode = Extract<WorkflowNode, { kind: "HUMAN_DECISION" }>;

export function WorkflowDecisionPanel({
  node,
  disabled,
  decide,
}: Readonly<{
  node: HumanDecisionNode;
  disabled?: boolean;
  decide(choice: string): void;
}>) {
  return (
    <section aria-labelledby="workflow-decision-title">
      <h2 id="workflow-decision-title">Decision required</h2>
      <p>No agent process remains active while this workflow waits.</p>
      <div>
        {node.choices.map((choice) => (
          <button key={choice} type="button" disabled={disabled} onClick={() => decide(choice)}>
            {choice}
          </button>
        ))}
      </div>
    </section>
  );
}
