import { validDefinition } from "./valid.ts";

export const missingFix = {
  ...validDefinition,
  transitions: validDefinition.transitions.filter(
    (transition) => transition.resultKey !== "CHANGES_REQUESTED",
  ),
};
