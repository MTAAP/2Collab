import type { WorkflowEngine } from "./contract.ts";

export function createWorkflowScheduler(engine: WorkflowEngine) {
  return {
    tick: () => engine.tick(),
    failAfterIntentCommitOnce: () => engine.failAfterIntentCommitOnce(),
  };
}
