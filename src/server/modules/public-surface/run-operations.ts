import type { Result } from "../../../shared/contracts/result.ts";
import type { PublicRunOperations } from "./contract.ts";

function notImplemented(): Result<never> {
  return {
    ok: false,
    error: {
      code: "RUNS_NOT_IMPLEMENTED",
      message: "Run operations are not implemented.",
      retry: "NEVER",
    },
  };
}

export function createStubRunOperations(): PublicRunOperations {
  return {
    create: async () => notImplemented(),
    inspect: async () => notImplemented(),
    cancel: async () => notImplemented(),
    resume: async () => notImplemented(),
    evidence: async () => notImplemented(),
  };
}
