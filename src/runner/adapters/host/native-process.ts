import type { SupervisorLaunch, TrustedHostPort } from "../../execution-contract.ts";

type Child = ReturnType<typeof Bun.spawn>;

async function pump(
  stream: ReadableStream<Uint8Array>,
  kind: "STDOUT" | "STDERR",
  execution: SupervisorLaunch,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      const text = new TextDecoder().decode(next.value);
      if (text) await execution.headlessOutput?.({ kind, text });
    }
  } finally {
    reader.releaseLock();
  }
}

export function createNativeProcessPort(
  dependencies: Readonly<{
    resolveWorktree(worktreeId: string): string | undefined;
    clock?: () => number;
    onExit?: (
      input: Readonly<{
        attemptId: string;
        exitCode: number;
        cancelled: boolean;
      }>,
    ) => void;
  }>,
): TrustedHostPort {
  const clock = dependencies.clock ?? (() => Math.floor(Date.now() / 1_000));
  const processes = new Map<string, Child>();
  const cancelled = new Set<string>();
  return {
    async start(execution) {
      const cwd = dependencies.resolveWorktree(execution.worktree.id);
      if (!cwd) throw new Error("WORKTREE_MAPPING_INVALID");
      const child = Bun.spawn([...execution.invocation.argv], {
        cwd,
        env: { ...execution.environment },
        stdin: execution.invocation.prompt.transport === "STDIN" ? "pipe" : "ignore",
        stdout: execution.interaction === "HEADLESS" ? "pipe" : "inherit",
        stderr: execution.interaction === "HEADLESS" ? "pipe" : "inherit",
      });
      const stdin = child.stdin;
      const stdout = child.stdout;
      const stderr = child.stderr;
      if (
        (execution.invocation.prompt.transport === "STDIN" && !stdin) ||
        (execution.interaction === "HEADLESS" && (!stdout || !stderr))
      ) {
        child.kill("SIGTERM");
        throw new Error("HOST_START_FAILED");
      }
      const processId = `pid:${child.pid}`;
      processes.set(processId, child);
      if (execution.invocation.prompt.transport === "STDIN") {
        stdin?.write(execution.invocation.prompt.text);
        stdin?.end();
      }
      const remaining = Math.max(0, execution.deadlineAt - clock());
      const deadline = setTimeout(() => {
        if (processes.has(processId)) child.kill("SIGTERM");
      }, remaining * 1_000);
      deadline.unref?.();
      void (async () => {
        try {
          const streams =
            execution.interaction === "HEADLESS"
              ? [
                  pump(stdout as ReadableStream<Uint8Array>, "STDOUT", execution),
                  pump(stderr as ReadableStream<Uint8Array>, "STDERR", execution),
                ]
              : [];
          const exitCode = await child.exited;
          await Promise.all(streams);
          await execution.headlessOutput?.({
            kind: "EXIT",
            exitCode,
            signal: null,
          });
          dependencies.onExit?.({
            attemptId: execution.attemptId,
            exitCode,
            cancelled: cancelled.has(processId),
          });
        } finally {
          clearTimeout(deadline);
          processes.delete(processId);
          cancelled.delete(processId);
        }
      })().catch(() => undefined);
      return { opaqueProcessId: processId };
    },
    async cancel(processId) {
      const child = processes.get(processId);
      if (!child) return false;
      cancelled.add(processId);
      child.kill("SIGTERM");
      return true;
    },
    async inspect(processId) {
      const child = processes.get(processId);
      if (!child) return "EXITED";
      return child.exitCode === null ? "RUNNING" : "EXITED";
    },
    async attach() {
      throw new Error("HOST_ATTACHMENT_UNAVAILABLE");
    },
  };
}
