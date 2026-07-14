import type { WorkflowEngine } from "./contract.ts";

export function createWorkflowScheduler(engine: WorkflowEngine) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  const tick = (): Promise<void> => {
    if (running) return running;
    const started = Promise.resolve().then(() => engine.tick());
    const tracked = started.finally(() => {
      if (running === tracked) running = undefined;
    });
    running = tracked;
    return tracked;
  };
  return {
    tick,
    failAfterIntentCommitOnce: () => engine.failAfterIntentCommitOnce(),
    start(intervalMilliseconds = 1_000) {
      if (timer) return;
      timer = setInterval(() => void tick().catch(() => undefined), intervalMilliseconds);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running?.catch(() => undefined);
    },
    state: () => ({ stopped: timer === undefined, running: running !== undefined }),
  };
}
