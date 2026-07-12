import { validDefinition } from "./valid.ts";

export const parallelMutator = {
  ...validDefinition,
  nodes: [
    ...validDefinition.nodes,
    { kind: "PARALLEL_SPLIT" as const, key: "split", branchKeys: ["implement", "review"] },
  ],
};
