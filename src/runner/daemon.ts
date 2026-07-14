import type { Result } from "../shared/contracts/result.ts";

export type RunnerDaemonState = "STOPPED" | "STARTING" | "RUNNING" | "QUIESCING" | "FAILED";

type Dependencies = Readonly<{
  reconcile: () => Promise<Result<Readonly<{ reconciled: number }>>>;
  transport: Readonly<{
    start(): Promise<void>;
    quiesce(deadline: number): Promise<Readonly<{ closed: number; pending: number }>>;
    stop(): Promise<void>;
  }>;
  localState: Readonly<{ close(): void }>;
  clock: () => number;
}>;

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

export function createRunnerDaemon(dependencies: Dependencies) {
  let state: RunnerDaemonState = "STOPPED";
  let reconciled = 0;
  let startPromise: Promise<Result<Readonly<{ state: "RUNNING"; reconciled: number }>>> | undefined;

  const daemon = {
    get state(): RunnerDaemonState {
      return state;
    },

    async start(): Promise<Result<Readonly<{ state: "RUNNING"; reconciled: number }>>> {
      if (state === "RUNNING") return { ok: true, value: { state: "RUNNING", reconciled } };
      if (state === "STARTING" && startPromise) return startPromise;
      if (state !== "STOPPED") {
        return failure("RUNNER_DAEMON_STATE_INVALID", "Runner daemon cannot be started.");
      }
      state = "STARTING";
      startPromise = (async () => {
        const reconciliation = await dependencies.reconcile();
        if (!reconciliation.ok) {
          state = "FAILED";
          return reconciliation;
        }
        reconciled = reconciliation.value.reconciled;
        try {
          await dependencies.transport.start();
          state = "RUNNING";
          return { ok: true as const, value: { state: "RUNNING" as const, reconciled } };
        } catch {
          state = "FAILED";
          return failure("RUNNER_TRANSPORT_START_FAILED", "Runner transport failed to start.");
        }
      })();
      return startPromise;
    },

    async shutdown(drainSeconds: number): Promise<
      Result<
        Readonly<{
          state: "STOPPED";
          closedConnections: number;
          pendingDeliveries: number;
        }>
      >
    > {
      if (!Number.isSafeInteger(drainSeconds) || drainSeconds < 0 || drainSeconds > 60) {
        return failure("RUNNER_SHUTDOWN_INVALID", "Runner shutdown deadline is invalid.");
      }
      if (state !== "RUNNING") {
        return failure("RUNNER_DAEMON_STATE_INVALID", "Runner daemon is not running.");
      }
      state = "QUIESCING";
      try {
        const result = await dependencies.transport.quiesce(dependencies.clock() + drainSeconds);
        await dependencies.transport.stop();
        dependencies.localState.close();
        state = "STOPPED";
        startPromise = undefined;
        return {
          ok: true,
          value: {
            state: "STOPPED",
            closedConnections: result.closed,
            pendingDeliveries: result.pending,
          },
        };
      } catch {
        state = "FAILED";
        return failure("RUNNER_SHUTDOWN_FAILED", "Runner shutdown failed.");
      }
    },
  };
  return daemon;
}
