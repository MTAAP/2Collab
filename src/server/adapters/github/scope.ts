import type { Result } from "../../../shared/contracts/result.ts";

export type GitHubScopeInput = Readonly<{
  connectorId: string;
  connectorEpoch: number;
  expectedConnectorEpoch: number;
  selectedRepositoryIds: ReadonlySet<string>;
  providerRepositoryIds: ReadonlySet<string>;
  selectedProjectIds: ReadonlySet<string>;
  repositoryId?: string;
  projectNodeId?: string;
  providerPermissions?: Readonly<Record<string, "read" | "write">>;
  requiredPermission?: Readonly<{ name: string; level: "read" | "write" }>;
}>;

export type GitHubAuthorizedScope = Readonly<{
  connectorId: string;
  connectorEpoch: number;
  repositoryId?: string;
  projectNodeId?: string;
}>;

function denied(code: string, message: string, retry: "NEVER" | "REFRESH" = "NEVER"): Result<never> {
  return { ok: false, error: { code, message, retry } };
}

export function assertGitHubScope(input: GitHubScopeInput): Result<GitHubAuthorizedScope> {
  if (input.connectorEpoch !== input.expectedConnectorEpoch) {
    return denied("CONNECTOR_REVOKED", "GitHub connector authority changed.", "REFRESH");
  }
  if (input.repositoryId) {
    if (!input.selectedRepositoryIds.has(input.repositoryId)) {
      return denied("GITHUB_REPOSITORY_NOT_SELECTED", "GitHub repository is not selected.");
    }
    if (!input.providerRepositoryIds.has(input.repositoryId)) {
      return denied("GITHUB_REPOSITORY_UNAVAILABLE", "GitHub repository is unavailable.", "REFRESH");
    }
  }
  if (input.projectNodeId && !input.selectedProjectIds.has(input.projectNodeId)) {
    return denied("GITHUB_PROJECT_NOT_SELECTED", "GitHub Project is not selected.");
  }
  if (input.requiredPermission) {
    const actual = input.providerPermissions?.[input.requiredPermission.name];
    if (!actual || (input.requiredPermission.level === "write" && actual !== "write")) {
      return denied("GITHUB_PERMISSION_DENIED", "GitHub App permission is insufficient.");
    }
  }
  return {
    ok: true,
    value: {
      connectorId: input.connectorId,
      connectorEpoch: input.connectorEpoch,
      repositoryId: input.repositoryId,
      projectNodeId: input.projectNodeId,
    },
  };
}

export function selectedRepositoryIdFromReference(reference: string): string | null {
  const match = /^(?:REPOSITORY|ISSUE|PULL_REQUEST|MILESTONE):([0-9]{1,32})(?::|$)/.exec(reference);
  return match?.[1] ?? null;
}
