import { validDefinition } from "./valid.ts";

export const unboundedCycle = { ...validDefinition, cycleBounds: {} };
