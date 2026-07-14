import { validDefinition } from "./valid.ts";

export const incompatibleResult = {
  ...validDefinition,
  nodes: validDefinition.nodes.map((node) =>
    node.kind === "AGENT_RUN" && node.key === "review"
      ? { ...node, resultKeys: ["UNDECLARED"] }
      : node,
  ),
};
