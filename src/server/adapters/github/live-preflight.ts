import { lstat, readFile } from "node:fs/promises";
import type { Result } from "../../../shared/contracts/result.ts";
import { createGitHubAppJwt, requestInstallationToken } from "./app-auth.ts";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ApprovedGitHubLiveConfiguration = Readonly<{
  approvalId: string;
  appId: string;
  installationId: string;
  privateKey: Uint8Array;
  webhookSecret: Uint8Array;
  repository: Readonly<{ id: string; nodeId: string; owner: string; name: string }>;
  project: Readonly<{ nodeId: string; owner: string }>;
}>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NUMERIC_ID = /^[0-9]{1,32}$/;

function failure(code: string, retry: "NEVER" | "SAME_INPUT" = "NEVER"): Result<never> {
  return {
    ok: false,
    error: { code, message: "GitHub live preflight failed.", retry },
  };
}

async function readSecret(path: string | undefined, maximum: number): Promise<Result<Uint8Array>> {
  if (!path || path.length > 1_024) return failure("GITHUB_LIVE_CONFIGURATION_INVALID");
  try {
    const stats = await lstat(path);
    const uid = process.getuid?.();
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o777) !== 0o600 ||
      (uid !== undefined && stats.uid !== uid) ||
      stats.size < 1 ||
      stats.size > maximum
    )
      return failure("GITHUB_LIVE_SECRET_FILE_INVALID");
    const value = await readFile(path);
    return value.length >= 1 && value.length <= maximum
      ? { ok: true, value: new Uint8Array(value) }
      : failure("GITHUB_LIVE_SECRET_FILE_INVALID");
  } catch {
    return failure("GITHUB_LIVE_SECRET_FILE_INVALID");
  }
}

/**
 * Loads only an explicitly approved, exact disposable GitHub scope. Secret material must be in
 * owner-only regular files and is never included in an error or serialized result.
 */
export async function readApprovedGitHubLiveConfiguration(
  source: Readonly<Record<string, string | undefined>>,
): Promise<Result<ApprovedGitHubLiveConfiguration>> {
  if (source.COLLAB_LIVE_GITHUB !== "1") return failure("GITHUB_LIVE_NOT_AUTHORIZED");
  const approvalId = source.COLLAB_GITHUB_APPROVAL_ID;
  const appId = source.COLLAB_GITHUB_APP_ID;
  const installationId = source.COLLAB_GITHUB_INSTALLATION_ID;
  const repositoryId = source.COLLAB_GITHUB_REPOSITORY_ID;
  const repositoryNodeId = source.COLLAB_GITHUB_REPOSITORY_NODE_ID;
  const repositoryOwner = source.COLLAB_GITHUB_REPOSITORY_OWNER;
  const repositoryName = source.COLLAB_GITHUB_REPOSITORY_NAME;
  const projectNodeId = source.COLLAB_GITHUB_PROJECT_NODE_ID;
  const projectOwner = source.COLLAB_GITHUB_PROJECT_OWNER;
  if (
    !approvalId ||
    !IDENTIFIER.test(approvalId) ||
    !appId ||
    !NUMERIC_ID.test(appId) ||
    !installationId ||
    !NUMERIC_ID.test(installationId) ||
    !repositoryId ||
    !NUMERIC_ID.test(repositoryId) ||
    !repositoryNodeId ||
    !PROVIDER_ID.test(repositoryNodeId) ||
    !repositoryOwner ||
    !LOGIN.test(repositoryOwner) ||
    !repositoryName ||
    !REPOSITORY.test(repositoryName) ||
    !projectNodeId ||
    !PROVIDER_ID.test(projectNodeId) ||
    !projectOwner ||
    !LOGIN.test(projectOwner)
  )
    return failure("GITHUB_LIVE_CONFIGURATION_INVALID");
  const privateKey = await readSecret(source.COLLAB_GITHUB_PRIVATE_KEY_FILE, 32_768);
  if (!privateKey.ok) return privateKey;
  const webhookSecret = await readSecret(source.COLLAB_GITHUB_WEBHOOK_SECRET_FILE, 1_024);
  if (!webhookSecret.ok || webhookSecret.value.length < 16)
    return failure("GITHUB_LIVE_SECRET_FILE_INVALID");
  return {
    ok: true,
    value: {
      approvalId,
      appId,
      installationId,
      privateKey: privateKey.value,
      webhookSecret: webhookSecret.value,
      repository: {
        id: repositoryId,
        nodeId: repositoryNodeId,
        owner: repositoryOwner,
        name: repositoryName,
      },
      project: { nodeId: projectNodeId, owner: projectOwner },
    },
  };
}

type PreflightDependencies = Readonly<{
  now?: () => number;
  fetcher?: Fetcher;
  createJwt?: typeof createGitHubAppJwt;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function boundedJson(response: Response): Promise<Result<unknown>> {
  if (!response.ok) return failure("GITHUB_LIVE_RESOURCE_UNAVAILABLE", "SAME_INPUT");
  const text = await response.text();
  if (text.length > 1_048_576) return failure("GITHUB_LIVE_RESPONSE_INVALID");
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return failure("GITHUB_LIVE_RESPONSE_INVALID");
  }
}

/** Read-only proof that the approved App installation can reach only the named live resources. */
export async function preflightGitHubApp(
  configuration: ApprovedGitHubLiveConfiguration,
  dependencies: PreflightDependencies = {},
): Promise<
  Result<
    Readonly<{
      approvalId: string;
      installationId: string;
      repository: string;
      repositoryId: string;
      projectNodeId: string;
      projectTitle: string;
    }>
  >
> {
  const fetcher = dependencies.fetcher ?? fetch;
  const jwt = (dependencies.createJwt ?? createGitHubAppJwt)({
    appId: configuration.appId,
    privateKey: configuration.privateKey,
    now: (dependencies.now ?? Date.now)(),
  });
  if (!jwt.ok) return jwt;
  const issued = await requestInstallationToken({
    appJwt: jwt.value,
    installationId: configuration.installationId,
    repositoryIds: [configuration.repository.id],
    permissions: {
      checks: "read",
      contents: "read",
      issues: "write",
      metadata: "read",
      organization_projects: "write",
      pull_requests: "read",
    },
    fetcher,
  });
  if (!issued.ok) return issued;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${issued.value.token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
  const repositoryResponse = await boundedJson(
    await fetcher(`https://api.github.com/repositories/${configuration.repository.id}`, {
      headers,
    }),
  );
  if (!repositoryResponse.ok) return repositoryResponse;
  const repository = record(repositoryResponse.value);
  if (
    String(repository?.id) !== configuration.repository.id ||
    repository?.node_id !== configuration.repository.nodeId ||
    repository?.full_name !== `${configuration.repository.owner}/${configuration.repository.name}`
  )
    return failure("GITHUB_LIVE_REPOSITORY_MISMATCH");
  const projectResponse = await boundedJson(
    await fetcher("https://api.github.com/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({
        query:
          "query($id:ID!){node(id:$id){... on ProjectV2{id title owner{... on Organization{login}}}}}",
        variables: { id: configuration.project.nodeId },
      }),
    }),
  );
  if (!projectResponse.ok) return projectResponse;
  const project = record(record(projectResponse.value)?.data)?.node;
  const projectRecord = record(project);
  const projectOwner = record(projectRecord?.owner)?.login;
  if (
    projectRecord?.id !== configuration.project.nodeId ||
    projectOwner !== configuration.project.owner
  )
    return failure("GITHUB_LIVE_PROJECT_MISMATCH");
  const title = projectRecord.title;
  if (typeof title !== "string" || title.length < 1 || title.length > 256)
    return failure("GITHUB_LIVE_RESPONSE_INVALID");
  return {
    ok: true,
    value: {
      approvalId: configuration.approvalId,
      installationId: configuration.installationId,
      repository: `${configuration.repository.owner}/${configuration.repository.name}`,
      repositoryId: configuration.repository.id,
      projectNodeId: configuration.project.nodeId,
      projectTitle: title,
    },
  };
}
