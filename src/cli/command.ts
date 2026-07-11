import type { LocalProjectRegistry } from "../runner/repository/global-registry.ts";
import { APP_METADATA } from "../shared/app-metadata.ts";
import { readServerEnvironment } from "../shared/environment.ts";
import type { PublicRunClient } from "./api-client.ts";
import { initProject } from "./commands/init.ts";
import { listCurrentProject } from "./commands/list.ts";
import { listKnownProjects } from "./commands/projects.ts";
import { startRun } from "./commands/start.ts";
import { projectStatus } from "./commands/status.ts";
import type { ProjectsApi } from "./ports/projects-api.ts";
import type { WorkflowAuthoringOperations } from "../server/modules/workflows/authoring.ts";
import type { TemplateBindingOperations } from "../server/modules/templates/bindings.ts";
import { workflowCommand } from "./commands/workflows.ts";
import { templateCommand } from "./commands/templates.ts";

export type CliIo = {
  error: (line: string) => void;
  log: (line: string) => void;
};

export type CliDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  runtimeVersion: string;
  cwd?: string;
  projectsApi?: ProjectsApi;
  registry?: LocalProjectRegistry;
  runsApi?: PublicRunClient;
  mcpBridge?: () => Promise<void>;
  workflowOperations?: WorkflowAuthoringOperations;
  templateOperations?: TemplateBindingOperations;
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
  "  init       Link the current checkout to an existing Project",
  "  list       Show the current Project coordination view",
  "  projects   Show all locally known Projects",
  "  status     Show current Project status; use --all for all known Projects",
  "  start      Create an Agent Run from a Personal Run Preset",
  "  run        Exact alias for start",
  "  mcp        Serve the public tools over stdio",
  "  workflows  Save a canonical workflow draft",
  "  templates  Bind an exact workflow preset",
  "  --version  Print the CLI version",
  "  --help     Show this help",
];

export async function runCli(
  args: readonly string[],
  io: CliIo = defaultIo,
  dependencies: CliDependencies = {
    environment: Bun.env,
    runtimeVersion: Bun.version,
    cwd: process.cwd(),
  },
): Promise<number> {
  const [command, ...commandArgs] = args;

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

  if (command === "start" || command === "run") {
    if (!dependencies.runsApi) {
      io.error("DEVICE_AUTHENTICATION_REQUIRED");
      return 3;
    }
    try {
      const output = await startRun(commandArgs, dependencies.runsApi);
      if (output.json) io.log(JSON.stringify(output.result));
      else if (output.result.ok)
        io.log(`Run ${output.result.value.run.id} is ${output.result.value.run.state}.`);
      else io.error(output.result.error.code);
      return output.result.ok ? 0 : 1;
    } catch (error) {
      io.error(error instanceof Error ? error.message : "RUN_ARGUMENTS_INVALID");
      return 2;
    }
  }

  if (command === "mcp") {
    if (commandArgs.length > 0) {
      io.error("MCP_ARGUMENTS_INVALID");
      return 2;
    }
    if (!dependencies.mcpBridge) {
      io.error("DEVICE_AUTHENTICATION_REQUIRED");
      return 3;
    }
    await dependencies.mcpBridge();
    return 0;
  }

  if (command === "workflows" || command === "templates") {
    const operations =
      command === "workflows" ? dependencies.workflowOperations : dependencies.templateOperations;
    if (!operations) {
      io.error("AUTOMATION_NOT_CONFIGURED");
      return 3;
    }
    try {
      const result =
        command === "workflows"
          ? await workflowCommand(commandArgs, operations as WorkflowAuthoringOperations)
          : await templateCommand(commandArgs, operations as TemplateBindingOperations);
      io.log(JSON.stringify(result));
      return result.ok ? 0 : 1;
    } catch (error) {
      io.error(error instanceof Error ? error.message : "AUTOMATION_ARGUMENTS_INVALID");
      return 2;
    }
  }

  if (["init", "list", "projects", "status"].includes(command)) {
    if (!dependencies.projectsApi || !dependencies.registry) {
      io.error("PROJECTS_NOT_CONFIGURED");
      return 1;
    }
    const cwd = dependencies.cwd ?? process.cwd();
    try {
      if (command === "init") {
        let projectId: string | undefined;
        let serverOrigin: string | undefined;
        let replaceLocalMapping = false;
        for (let index = 0; index < commandArgs.length; index += 1) {
          const argument = commandArgs[index];
          if (argument === "--replace-local-mapping") {
            if (replaceLocalMapping) throw new Error("PROJECT_ARGUMENTS_INVALID");
            replaceLocalMapping = true;
            continue;
          }
          const value = commandArgs[index + 1];
          if (!value || value.startsWith("--")) throw new Error("PROJECT_ARGUMENTS_INVALID");
          if (argument === "--project" && projectId === undefined) projectId = value;
          else if (argument === "--server" && serverOrigin === undefined) serverOrigin = value;
          else throw new Error("PROJECT_ARGUMENTS_INVALID");
          index += 1;
        }
        if (!projectId || !serverOrigin) throw new Error("PROJECT_ARGUMENTS_INVALID");
        io.log(
          JSON.stringify(
            await initProject(
              { cwd, projectId, serverOrigin, replaceLocalMapping },
              { projectsApi: dependencies.projectsApi, registry: dependencies.registry },
            ),
          ),
        );
        return 0;
      }
      if (command === "list") {
        if (commandArgs.length > 0) throw new Error("PROJECT_ARGUMENTS_INVALID");
        io.log(
          JSON.stringify(
            await listCurrentProject(cwd, dependencies.projectsApi, dependencies.registry),
          ),
        );
        return 0;
      }
      if (command === "projects") {
        if (commandArgs.length > 0) throw new Error("PROJECT_ARGUMENTS_INVALID");
        io.log(
          JSON.stringify(await listKnownProjects(dependencies.registry, dependencies.projectsApi)),
        );
        return 0;
      }
      const all = commandArgs.length === 1 && commandArgs[0] === "--all";
      if (commandArgs.length > 0 && !all) throw new Error("PROJECT_ARGUMENTS_INVALID");
      io.log(
        JSON.stringify(
          await projectStatus(
            { cwd, all },
            { projectsApi: dependencies.projectsApi, registry: dependencies.registry },
          ),
        ),
      );
      return 0;
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
          ? error.message
          : "PROJECT_COMMAND_FAILED";
      io.error(code);
      return 1;
    }
  }

  io.error(`Unknown command: ${command}`);
  io.error("Run 'collab --help' to list bootstrap commands.");
  return 2;
}
