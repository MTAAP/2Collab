import { expect, test } from "bun:test";
import { createWorkflowScheduler } from "../../../src/server/modules/workflows/scheduler.ts";

test("scheduler shutdown waits for an in-flight workflow tick", async () => {
  let finish: () => void = () => undefined;
  const engine = {
    tick: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  };
  const scheduler = createWorkflowScheduler(engine as never);
  const ticking = scheduler.tick();
  await Promise.resolve();

  let stopped = false;
  const shutdown = scheduler.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);

  finish();
  await Promise.all([ticking, shutdown]);
  expect(stopped).toBe(true);
  expect(scheduler.state()).toEqual({ stopped: true, running: false });
});
