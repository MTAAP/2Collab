import { join } from "node:path";
import { CanonicalServerOriginSchema } from "../shared/contracts/projects.ts";
import {
  createProjectsApiClient,
  createPublicApiClient,
  type DeviceCredentialProvider,
} from "./api-client.ts";
import { createDeviceCredentialProvider } from "./credentials.ts";
import type { CliDependencies } from "./command.ts";
import { startStdioMcpBridge } from "./commands/mcp.ts";
import {
  openLocalProjectRegistry,
  type GlobalRegistryFilesystem,
} from "../runner/repository/global-registry.ts";

export type CliResources = Readonly<{
  cwd?: string;
  home?: string;
  runtimeVersion?: string;
  fetch?: typeof fetch;
  clock?: () => number;
  filesystem?: GlobalRegistryFilesystem;
  deviceCredentialProvider?: DeviceCredentialProvider;
}>;

export function createCliDependencies(
  environment: Readonly<Record<string, string | undefined>>,
  resources: CliResources = {},
): CliDependencies {
  const credentials =
    resources.deviceCredentialProvider ?? createDeviceCredentialProvider(environment);
  const baseUrl = CanonicalServerOriginSchema.safeParse(environment.COLLAB_BASE_URL);
  const home = resources.home ?? environment.HOME;

  const projectsApi = credentials
    ? createProjectsApiClient({ credentials, fetch: resources.fetch })
    : undefined;
  const runsApi =
    baseUrl.success && credentials
      ? createPublicApiClient({ baseUrl: baseUrl.data, credentials, fetch: resources.fetch })
      : undefined;

  const registry = home
    ? openLocalProjectRegistry(join(home, ".collab", "global.db"), {
        clock: resources.clock,
        filesystem: resources.filesystem,
      })
    : undefined;

  return {
    environment,
    runtimeVersion: resources.runtimeVersion ?? Bun.version,
    cwd: resources.cwd ?? process.cwd(),
    projectsApi,
    registry,
    runsApi,
    mcpBridge: runsApi ? () => startStdioMcpBridge(runsApi) : undefined,
  };
}
