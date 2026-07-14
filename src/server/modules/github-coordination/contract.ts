import type { PublishedGitReference } from "../../../shared/contracts/runs.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type {
  GitHubCheckObservation,
  GitHubMutation,
  GitHubProjection,
  GitHubReference,
  GitHubWorkItemReference,
  SourceDependency,
} from "../../../shared/contracts/github.ts";
import type { ConnectorScope, Observed, SourceConnector } from "../connectors/contract.ts";

export interface GitHubPort
  extends SourceConnector<GitHubReference, GitHubProjection, GitHubMutation> {
  observeChecks(
    scope: ConnectorScope,
    reference: PublishedGitReference,
  ): Promise<Result<Observed<readonly GitHubCheckObservation[]>>>;
  listDependencies(
    scope: ConnectorScope,
    reference: GitHubWorkItemReference,
  ): Promise<Result<Observed<readonly SourceDependency[]>>>;
}

export type WebhookReceipt = Readonly<{
  connectorId: string;
  hookId: string;
  deliveryId: string;
  disposition: "APPLIED" | "REPLAY" | "PENDING";
}>;
