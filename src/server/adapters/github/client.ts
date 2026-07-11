import type { PublishedGitReference } from "../../../shared/contracts/runs.ts";
import type { GitHubMutation, GitHubReference, GitHubWorkItemReference } from "../../../shared/contracts/github.ts";
import type { GitHubPort } from "./contract.ts";
import { assertGitHubScope } from "./scope.ts";
import type {
  ConnectorOperationAuthorization,
  ConnectorScope,
  ExactRevisionMutation,
  ReconciliationCursor,
} from "../../modules/connectors/contract.ts";

export type GitHubClientInput = Readonly<{
  connectorId: string;
  currentConnectorEpoch: () => number;
  selectedRepositoryIds: () => ReadonlySet<string>;
  providerRepositoryIds: () => ReadonlySet<string>;
  selectedProjectIds: () => ReadonlySet<string>;
  providerPermissions: () => Readonly<Record<string, "read" | "write">>;
  provider: GitHubPort;
}>;

function resource(reference: GitHubReference): Readonly<{ repositoryId?: string; projectNodeId?: string }> {
  return reference.kind === "PROJECT"
    ? { projectNodeId: reference.projectNodeId }
    : { repositoryId: reference.repositoryId };
}

function mutationReference(mutation: GitHubMutation): GitHubReference {
  switch (mutation.kind) {
    case "CREATE_ISSUE": return { kind: "ISSUE", repositoryId: mutation.repository.repositoryId, number: 1 };
    case "EDIT_ISSUE": case "ADD_COMMENT": case "SET_LABELS": case "SET_ASSIGNEES": case "SET_ISSUE_STATE": return mutation.issue;
    case "SET_MILESTONE": return mutation.item;
    case "CREATE_MILESTONE": return { kind: "MILESTONE", repositoryId: mutation.repository.repositoryId, number: 1 };
    case "EDIT_MILESTONE": return mutation.milestone;
    case "ADD_PROJECT_ITEM": case "REMOVE_PROJECT_ITEM": case "SET_PROJECT_FIELD": case "MOVE_PROJECT_ITEM": return mutation.project;
  }
}

export function createGitHubClient(input: GitHubClientInput): GitHubPort {
  const authorize = (scope: ConnectorScope, reference: GitHubReference, write: boolean) =>
    assertGitHubScope({
      connectorId: input.connectorId,
      connectorEpoch: scope.connectorEpoch,
      expectedConnectorEpoch: input.currentConnectorEpoch(),
      selectedRepositoryIds: input.selectedRepositoryIds(),
      providerRepositoryIds: input.providerRepositoryIds(),
      selectedProjectIds: input.selectedProjectIds(),
      providerPermissions: input.providerPermissions(),
      requiredPermission: {
        name: reference.kind === "PROJECT" ? "organization_projects" : "issues",
        level: write ? "write" : "read",
      },
      ...resource(reference),
    });
  return {
    async inspect(scope, reference) {
      const allowed = authorize(scope, reference, false);
      if (!allowed.ok) return allowed;
      const result = await input.provider.inspect(scope, reference);
      if (!result.ok) return result;
      const confirmed = authorize(scope, reference, false);
      return confirmed.ok ? result : confirmed;
    },
    async mutate(authorization: ConnectorOperationAuthorization, command: ExactRevisionMutation<GitHubMutation>) {
      const reference = mutationReference(command.mutation);
      const scope: ConnectorScope = { projectId: command.projectId, connectorId: command.connectorId, connectorEpoch: command.connectorEpoch, references: [authorization.reference], operations: [authorization.operation] };
      const allowed = authorize(scope, reference, true);
      if (!allowed.ok) return allowed;
      const result = await input.provider.mutate(authorization, command);
      if (!result.ok) return result;
      const confirmed = authorize(scope, reference, false);
      return confirmed.ok ? result : confirmed;
    },
    async *scan(scope: ConnectorScope, cursor?: ReconciliationCursor) {
      if (scope.connectorId !== input.connectorId || scope.connectorEpoch !== input.currentConnectorEpoch()) {
        yield { ok: false as const, error: { code: "CONNECTOR_REVOKED", message: "GitHub connector authority changed.", retry: "REFRESH" as const } };
        return;
      }
      yield* input.provider.scan(scope, cursor);
    },
    async observeChecks(scope: ConnectorScope, reference: PublishedGitReference) {
      if (scope.connectorId !== input.connectorId || scope.connectorEpoch !== input.currentConnectorEpoch()) return { ok: false, error: { code: "CONNECTOR_REVOKED", message: "GitHub connector authority changed.", retry: "REFRESH" } };
      return input.provider.observeChecks(scope, reference);
    },
    async listDependencies(scope: ConnectorScope, reference: GitHubWorkItemReference) {
      const allowed = authorize(scope, reference, false);
      return allowed.ok ? input.provider.listDependencies(scope, reference) : allowed;
    },
  };
}
