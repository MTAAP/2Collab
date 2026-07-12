import type { LocalProjectRegistry } from "../runner/repository/global-registry.ts";
import type { TemplateBindingOperations } from "../server/modules/templates/bindings.ts";
import type { WorkflowAuthoringOperations } from "../server/modules/workflows/authoring.ts";
import { APP_METADATA } from "../shared/app-metadata.ts";
import { readServerEnvironment } from "../shared/environment.ts";
import type { PublicRunClient } from "./api-client.ts";
import { initProject } from "./commands/init.ts";
import { listCurrentProject } from "./commands/list.ts";
import { listKnownProjects } from "./commands/projects.ts";
import { startRun } from "./commands/start.ts";
import { projectStatus } from "./commands/status.ts";
import { templateCommand } from "./commands/templates.ts";
import { workflowCommand } from "./commands/workflows.ts";
import type { DeviceEnrollment } from "./credentials.ts";
import type { ProjectsApi } from "./ports/projects-api.ts";
import type { ProductionRunnerManagement } from "../runner/production.ts";

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
  deviceEnrollment?: DeviceEnrollment;
  runnerManagement?: ProductionRunnerManagement;
};

const defaultIo: CliIo = {
  error: (line) => console.error(line),
  log: (line) => console.log(line),
};

function validIdentifier(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function parseRunnerOptions(
  args: readonly string[],
  allowed: readonly string[],
): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !allowed.includes(key) || !value || values.has(key))
      throw new Error("RUNNER_ARGUMENTS_INVALID");
    values.set(key, value);
  }
  return values;
}

function uniqueList<const T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
): T[number][] | undefined {
  const values = value?.split(",");
  return values &&
    values.length > 0 &&
    values.length <= allowed.length &&
    values.every((item) => (allowed as readonly string[]).includes(item)) &&
    new Set(values).size === values.length
    ? values
    : undefined;
}

const HELP = [
  "2Collab bootstrap CLI",
  "",
  "Usage: collab <command>",
  "",
  "Commands:",
  "  doctor     Validate the local bootstrap runtime and server configuration",
  "  auth       Begin or complete OS-keychain-backed device enrollment",
  "  runner     Pair, configure, install, start, or inspect the local runner service",
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

  if (command === "auth") {
    if (!dependencies.deviceEnrollment) {
      io.error("OS_CREDENTIAL_STORE_UNAVAILABLE");
      return 3;
    }
    try {
      if (commandArgs.length === 1 && commandArgs[0] === "begin") {
        io.log(JSON.stringify(await dependencies.deviceEnrollment.begin()));
        return 0;
      }
      if (commandArgs.length === 1 && commandArgs[0] === "complete") {
        io.log(JSON.stringify(await dependencies.deviceEnrollment.complete()));
        return 0;
      }
      io.error("AUTH_ARGUMENTS_INVALID");
      return 2;
    } catch (error) {
      io.error(error instanceof Error ? error.message : "DEVICE_ENROLLMENT_FAILED");
      return 1;
    }
  }

  if (command === "runner") {
    if (!dependencies.runnerManagement) {
      io.error("RUNNER_NOT_CONFIGURED");
      return 3;
    }
    try {
      const [action, phase] = commandArgs;
      let result: unknown;
      if (action === "pair" && phase === "begin" && commandArgs.length === 2)
        result = await dependencies.runnerManagement.pairBegin();
      else if (action === "pair" && phase === "complete" && commandArgs.length === 2)
        result = await dependencies.runnerManagement.pairComplete();
      else if (action === "install" && commandArgs.length === 1)
        result = await dependencies.runnerManagement.install();
      else if (action === "start" && commandArgs.length === 1)
        result = await dependencies.runnerManagement.start();
      else if (action === "daemon" && commandArgs.length === 1) {
        result = await dependencies.runnerManagement.start();
      } else if (action === "status" && commandArgs.length === 1)
        result = await dependencies.runnerManagement.status();
      else if (action === "project" && phase === "configure") {
        const values = new Map<string, string>();
        const allowed = new Set([
          "--project",
          "--repository",
          "--revision",
          "--checkout",
          "--base-branch",
          "--remote",
          "--remote-ref",
        ]);
        for (let index = 2; index < commandArgs.length; index += 2) {
          const key = commandArgs[index];
          const value = commandArgs[index + 1];
          if (!key || !allowed.has(key) || !value || values.has(key))
            throw new Error("RUNNER_ARGUMENTS_INVALID");
          values.set(key, value);
        }
        const revision = Number(values.get("--revision"));
        const projectId = values.get("--project");
        const repositoryId = values.get("--repository");
        const checkout = values.get("--checkout");
        const baseBranch = values.get("--base-branch");
        if (
          !projectId ||
          !repositoryId ||
          !checkout ||
          !baseBranch ||
          !Number.isSafeInteger(revision) ||
          revision < 1
        )
          throw new Error("RUNNER_ARGUMENTS_INVALID");
        result = await dependencies.runnerManagement.configureProject({
          projectId,
          repositoryId,
          mappingRevision: revision,
          checkout,
          baseBranch,
          ...(values.get("--remote") ? { remoteName: values.get("--remote") } : {}),
          ...(values.get("--remote-ref") ? { remoteRef: values.get("--remote-ref") } : {}),
        });
      } else if (action === "profile" && phase === "install-default") {
        const values = new Map<string, string>();
        const allowed = new Set(["--runtime", "--id", "--executable"]);
        for (let index = 2; index < commandArgs.length; index += 2) {
          const key = commandArgs[index];
          const value = commandArgs[index + 1];
          if (!key || !allowed.has(key) || !value || values.has(key))
            throw new Error("RUNNER_ARGUMENTS_INVALID");
          values.set(key, value);
        }
        const runtime = values.get("--runtime");
        const profileVersionId = values.get("--id");
        if (
          (runtime !== "CODEX" && runtime !== "CLAUDE") ||
          !profileVersionId ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(profileVersionId)
        )
          throw new Error("RUNNER_ARGUMENTS_INVALID");
        result = await dependencies.runnerManagement.installDefaultProfile({
          runtime,
          profileVersionId,
          ...(values.get("--executable") ? { executable: values.get("--executable") } : {}),
        });
      } else if (action === "mapping" && (phase === "register" || phase === "replace")) {
        const values = parseRunnerOptions(
          commandArgs.slice(2),
          phase === "register"
            ? ["--project", "--mapping-id"]
            : ["--project", "--mapping-id", "--expected-revision"],
        );
        const projectId = values.get("--project");
        const localMappingId = values.get("--mapping-id");
        if (!validIdentifier(projectId) || !validIdentifier(localMappingId))
          throw new Error("RUNNER_ARGUMENTS_INVALID");
        if (phase === "register") {
          result = await dependencies.runnerManagement.registerMapping({
            projectId,
            localMappingId,
          });
        } else {
          const expectedRevision = Number(values.get("--expected-revision"));
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
            throw new Error("RUNNER_ARGUMENTS_INVALID");
          result = await dependencies.runnerManagement.replaceMapping({
            projectId,
            localMappingId,
            expectedRevision,
          });
        }
      } else if (action === "profile" && phase === "advertise") {
        const values = parseRunnerOptions(commandArgs.slice(2), [
          "--id",
          "--expected-version",
          "--display-name",
          "--runtime",
          "--hosts",
          "--interactions",
          "--risk-summary",
          "--fingerprint",
        ]);
        const profileId = values.get("--id");
        const expectedVersionValue = values.get("--expected-version");
        const expectedVersion = Number(expectedVersionValue);
        const displayName = values.get("--display-name");
        const adapter = values.get("--runtime");
        const hosts = uniqueList(values.get("--hosts"), ["NATIVE", "ORCA"] as const);
        const interactions = uniqueList(values.get("--interactions"), [
          "HEADLESS",
          "INTERACTIVE",
        ] as const);
        const riskSummary = values.get("--risk-summary");
        const fingerprint = values.get("--fingerprint");
        if (
          (profileId === undefined) !== (expectedVersionValue === undefined) ||
          (profileId !== undefined && !validIdentifier(profileId)) ||
          (expectedVersionValue !== undefined &&
            (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) ||
          !displayName ||
          displayName.length > 120 ||
          !["CLAUDE", "CODEX", "PI", "OPENCODE"].includes(adapter ?? "") ||
          !hosts ||
          !interactions ||
          !riskSummary ||
          riskSummary.length > 240 ||
          !fingerprint ||
          !/^[a-f0-9]{64}$/.test(fingerprint)
        )
          throw new Error("RUNNER_ARGUMENTS_INVALID");
        result = await dependencies.runnerManagement.advertiseProfile({
          ...(profileId ? { profileId, expectedVersion } : {}),
          displayName,
          adapter: adapter as "CLAUDE" | "CODEX" | "PI" | "OPENCODE",
          hosts,
          interactions,
          riskSummary,
          fingerprint,
        });
      } else {
        io.error("RUNNER_ARGUMENTS_INVALID");
        return 2;
      }
      io.log(JSON.stringify(result));
      if (action === "daemon") await new Promise(() => undefined);
      return 0;
    } catch (error) {
      io.error(error instanceof Error ? error.message : "RUNNER_OPERATION_FAILED");
      return 1;
    }
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
              {
                projectsApi: dependencies.projectsApi,
                registry: dependencies.registry,
              },
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
            {
              projectsApi: dependencies.projectsApi,
              registry: dependencies.registry,
            },
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
