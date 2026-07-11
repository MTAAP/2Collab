import { validDefinition } from "./valid.ts";

export const unreachable = {
  ...validDefinition,
  nodes: [
    ...validDefinition.nodes,
    { kind: "TERMINAL" as const, key: "orphan", outcome: "FAILED" as const },
  ],
};
