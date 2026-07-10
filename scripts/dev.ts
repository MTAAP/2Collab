export {};

type ManagedProcess = {
  label: string;
  process: Bun.Subprocess;
};

const commands = [
  { command: ["bun", "run", "dev:server"], label: "server" },
  { command: ["bun", "run", "dev:web"], label: "web" },
] as const;

const children: ManagedProcess[] = commands.map(({ command, label }) => ({
  label,
  process: Bun.spawn([...command], {
    env: process.env,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  }),
}));

let stopping = false;

function stopChildren(signal: NodeJS.Signals): void {
  if (stopping) {
    return;
  }

  stopping = true;
  for (const child of children) {
    try {
      child.process.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}

process.once("SIGINT", () => stopChildren("SIGINT"));
process.once("SIGTERM", () => stopChildren("SIGTERM"));

const firstExit = await Promise.race(
  children.map(async (child) => ({
    code: await child.process.exited,
    label: child.label,
  })),
);

stopChildren("SIGTERM");
await Promise.allSettled(children.map((child) => child.process.exited));

if (firstExit.code !== 0) {
  console.error(`${firstExit.label} development process exited with code ${firstExit.code}`);
}

process.exitCode = firstExit.code;
