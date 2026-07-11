import type { ConnectorScope } from "../connectors/contract.ts";
import type { Result } from "../../../shared/contracts/result.ts";

export type ReconciliationJobResult = Result<Readonly<{ notBefore?: number }>>;
export type GitHubReconciliationSchedulerInput = Readonly<{
  clock: () => number;
  intervalMs: number;
  maximumBackoffMs: number;
  scopes: () => readonly ConnectorScope[];
  reconcile: (scope: ConnectorScope) => Promise<ReconciliationJobResult>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}>;

export function createGitHubReconciliationScheduler(input: GitHubReconciliationSchedulerInput) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let stopped = true;
  let failures = 0;
  const set = input.setTimer ?? setTimeout;
  const clear = input.clearTimer ?? clearTimeout;

  const schedule = (delay: number) => {
    if (stopped) return;
    if (timer) clear(timer);
    timer = set(() => void tick(), Math.max(0, delay));
  };
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    let next = input.intervalMs;
    try {
      for (const scope of input.scopes()) {
        const result = await input.reconcile(scope);
        if (result.ok) {
          failures = 0;
          if (result.value.notBefore) next = Math.max(next, result.value.notBefore - input.clock());
        } else {
          failures += 1;
          next = Math.min(input.maximumBackoffMs, input.intervalMs * 2 ** Math.min(failures, 10));
        }
      }
    } finally {
      running = false;
      schedule(next);
    }
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    wake() {
      schedule(0);
    },
    async runNow() {
      stopped = false;
      await tick();
    },
    stop() {
      stopped = true;
      if (timer) clear(timer);
      timer = undefined;
    },
    state() {
      return { running, stopped, failures } as const;
    },
  };
}
