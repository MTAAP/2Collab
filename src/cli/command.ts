import { APP_METADATA } from "../shared/app-metadata.ts";
import { readServerEnvironment } from "../shared/environment.ts";

export type CliIo = {
  error: (line: string) => void;
  log: (line: string) => void;
};

type CliDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  runtimeVersion: string;
};

const defaultIo: CliIo = {
  error: (line) => console.error(line),
  log: (line) => console.log(line),
};

const HELP = [
  "2Collab bootstrap CLI",
  "",
  "Usage: collab <command>",
  "",
  "Commands:",
  "  doctor     Validate the local bootstrap runtime and server configuration",
  "  --version  Print the CLI version",
  "  --help     Show this help",
];

export async function runCli(
  args: readonly string[],
  io: CliIo = defaultIo,
  dependencies: CliDependencies = {
    environment: Bun.env,
    runtimeVersion: Bun.version,
  },
): Promise<number> {
  const [command] = args;

  if (command === "--version" || command === "-v") {
    io.log(`${APP_METADATA.name} ${APP_METADATA.version}`);
    return 0;
  }

  if (!command || command === "--help" || command === "-h") {
    for (const line of HELP) {
      io.log(line);
    }
    return 0;
  }

  if (command === "doctor") {
    const environment = readServerEnvironment(dependencies.environment);
    io.log("2Collab doctor");
    io.log(`Runtime: Bun ${dependencies.runtimeVersion}`);
    io.log(`Configuration: ${environment.mode} ${environment.hostname}:${environment.port}`);
    io.log("Status: READY (bootstrap diagnostics only)");
    return 0;
  }

  io.error(`Unknown command: ${command}`);
  io.error("Run 'collab --help' to list bootstrap commands.");
  return 2;
}
