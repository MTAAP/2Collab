import { validDefinition } from "./valid.ts";

export const missingTerminal = {
  ...validDefinition,
  nodes: validDefinition.nodes.filter((node) => node.kind !== "TERMINAL"),
};
