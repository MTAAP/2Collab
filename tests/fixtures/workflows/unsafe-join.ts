import { validDefinition } from "./valid.ts";

export const unsafeJoin = {
  ...validDefinition,
  nodes: [
    ...validDefinition.nodes,
    {
      kind: "JOIN" as const,
      key: "unsafe_join",
      branchKeys: ["implement", "review"],
      policy: "ANY" as const,
      acceptedResultKeys: ["APPROVED"],
      fallbackTargetKey: "failed",
    },
  ],
};
