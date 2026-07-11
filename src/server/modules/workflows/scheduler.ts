import type { WorkflowEngine } from "./contract.ts";

export function createWorkflowScheduler(engine: WorkflowEngine) {
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    tick: () => engine.tick(),
    failAfterIntentCommitOnce: () => engine.failAfterIntentCommitOnce(),
    start(intervalMilliseconds = 1_000) {
      if (timer) return;
      timer = setInterval(() => void engine.tick(), intervalMilliseconds);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    state: () => ({ stopped: timer === undefined }),
  };
}
