import type { Edge, Node } from "@xyflow/react";
import type { CanvasLayout, WorkflowDefinition } from "../../../shared/contracts/workflow.ts";

export type WorkflowFlowNode = Node<
  Readonly<{ semanticNode: WorkflowDefinition["nodes"][number] }>
>;

export function toReactFlow(
  definition: WorkflowDefinition,
  layout: CanvasLayout,
): Readonly<{
  nodes: readonly WorkflowFlowNode[];
  edges: readonly Edge[];
}> {
  const positions = new Map(layout.nodes.map((item) => [item.key, item]));
  return {
    nodes: definition.nodes.map((node) => {
      const position = positions.get(node.key) ?? { x: 0, y: 0 };
      return {
        id: node.key,
        position: { x: position.x, y: position.y },
        data: { semanticNode: node },
        ariaLabel: `${node.kind} ${node.key}`,
      };
    }),
    edges: definition.transitions.map((transition, index) => ({
      id: `transition-${index}`,
      source: transition.from,
      target: transition.to,
      label: transition.resultKey,
    })),
  };
}
