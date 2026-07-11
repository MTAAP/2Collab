import type { PublishedGitReference } from "../../../shared/contracts/runs.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import {
  githubReferenceKey,
  type GitHubCheckObservation,
  type GitHubMutation,
  type GitHubProjection,
  type GitHubReference,
  type GitHubWorkItemReference,
  type SourceDependency,
} from "../../../shared/contracts/github.ts";
import type {
  ConnectorOperationAuthorization,
  ConnectorScope,
  ExactRevisionMutation,
  Observed,
  ReconciliationCursor,
  ReconciliationEvent,
} from "../../modules/connectors/contract.ts";
import type { GitHubPort } from "../../modules/github-coordination/contract.ts";
import { GITHUB_REST_HEADERS } from "./app-auth.ts";
import { normalizeGitHubIssue } from "./issues.ts";
import { normalizeGitHubMilestone } from "./milestones.ts";
import { normalizeSelectedGitHubProject } from "./projects.ts";
import { normalizeGitHubPullRequest } from "./pull-requests.ts";

type Repository = Readonly<{ repositoryId: string; owner: string; name: string; nodeId: string }>;
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type GitHubRestProviderInput = Readonly<{
  connectorId: string;
  apiBaseUrl?: string;
  fetcher?: Fetcher;
  token(scope: ConnectorScope): Promise<Result<string>>;
  repository(repositoryId: string): Result<Repository>;
  workItemNodeId(reference: GitHubWorkItemReference): Result<string>;
  selectedRepositoryIds(scope: ConnectorScope): readonly string[];
  selectedProjectIds(scope: ConnectorScope): readonly string[];
  clock: () => number;
}>;

function failure(code: string, retry: "NEVER" | "REFRESH" | "SAME_INPUT" = "NEVER"): Result<never> {
  return { ok: false, error: { code, message: "GitHub provider operation failed.", retry } };
}
function digest(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
}
function checkStatus(value: unknown): GitHubCheckObservation["status"] {
  const normalized = String(value).toUpperCase();
  return normalized === "IN_PROGRESS" || normalized === "COMPLETED" ? normalized : "QUEUED";
}
function checkConclusion(value: unknown): GitHubCheckObservation["conclusion"] {
  const normalized = value === null || value === undefined ? null : String(value).toUpperCase();
  return normalized === "SUCCESS" ||
    normalized === "FAILURE" ||
    normalized === "NEUTRAL" ||
    normalized === "CANCELLED" ||
    normalized === "SKIPPED" ||
    normalized === "TIMED_OUT" ||
    normalized === "ACTION_REQUIRED"
    ? normalized
    : null;
}
function observed(
  scope: ConnectorScope,
  reference: string,
  value: GitHubProjection,
  sourceRevision: string,
  clock: () => number,
): Observed<GitHubProjection> {
  return {
    value,
    reference,
    sourceRevision,
    comparableDigest: digest(value) as never,
    projectionRevision: 0,
    observedAt: clock(),
    freshness: value.kind === "REDACTED" ? "REDACTED" : "FRESH",
    provenance: {
      projectId: scope.projectId,
      connectorId: scope.connectorId,
      connectorEpoch: scope.connectorEpoch,
      kind: "RECONCILIATION",
    },
  };
}

export function createGitHubRestProvider(input: GitHubRestProviderInput): GitHubPort {
  const base = input.apiBaseUrl ?? "https://api.github.com";
  const fetcher = input.fetcher ?? fetch;
  const request = async (
    scope: ConnectorScope,
    path: string,
    init: RequestInit = {},
  ): Promise<Result<unknown>> => {
    const token = await input.token(scope);
    if (!token.ok) return token;
    try {
      const response = await fetcher(`${base}${path}`, {
        ...init,
        headers: {
          ...GITHUB_REST_HEADERS,
          authorization: `Bearer ${token.value}`,
          "content-type": "application/json",
          ...init.headers,
        },
      });
      if (!response.ok)
        return failure(
          response.status === 404
            ? "GITHUB_MISSING"
            : response.status === 403
              ? "GITHUB_FORBIDDEN"
              : response.status === 429
                ? "GITHUB_RATE_LIMITED"
                : "GITHUB_UNAVAILABLE",
          response.status >= 500 || response.status === 429 ? "SAME_INPUT" : "REFRESH",
        );
      const text = await response.text();
      if (text.length > 1_048_576) return failure("GITHUB_RESPONSE_TOO_LARGE");
      return { ok: true, value: text ? JSON.parse(text) : {} };
    } catch {
      return failure("GITHUB_UNAVAILABLE", "SAME_INPUT");
    }
  };
  const repo = (id: string) => input.repository(id);
  const inspect = async (
    scope: ConnectorScope,
    reference: GitHubReference,
  ): Promise<Result<Observed<GitHubProjection>>> => {
    if (reference.kind === "PROJECT") {
      const result = await request(scope, "/graphql", {
        method: "POST",
        body: JSON.stringify({
          query:
            "query CollabSelectedProject($id:ID!){node(id:$id){... on ProjectV2{id title items(first:100){nodes{id content{... on Issue{number repository{databaseId}} ... on PullRequest{number repository{databaseId}}}}}}}}",
          variables: { id: reference.projectNodeId },
        }),
      });
      if (!result.ok) return result;
      const node = (result.value as any)?.data?.node;
      if (!node) return failure("GITHUB_MISSING");
      const items = (node.items?.nodes ?? []).map((item: any) => ({
        itemId: String(item.id),
        repositoryId: item.content?.repository?.databaseId
          ? String(item.content.repository.databaseId)
          : undefined,
        number: item.content?.number,
        title: "",
      }));
      const value = normalizeSelectedGitHubProject({
        projectNodeId: reference.projectNodeId,
        title: String(node.title),
        selectedRepositoryIds: new Set(input.selectedRepositoryIds(scope)),
        items,
      });
      return {
        ok: true,
        value: observed(
          scope,
          githubReferenceKey(reference),
          value,
          digest(result.value),
          input.clock,
        ),
      };
    }
    const metadata = repo(reference.repositoryId);
    if (!metadata.ok) return metadata;
    const root = `/repos/${encodeURIComponent(metadata.value.owner)}/${encodeURIComponent(metadata.value.name)}`;
    const path =
      reference.kind === "PULL_REQUEST"
        ? `${root}/pulls/${reference.number}`
        : reference.kind === "MILESTONE"
          ? `${root}/milestones/${reference.number}`
          : `${root}/issues/${reference.number}`;
    const result = await request(scope, path);
    if (!result.ok) return result;
    const value =
      reference.kind === "PULL_REQUEST"
        ? normalizeGitHubPullRequest(reference.repositoryId, result.value)
        : reference.kind === "MILESTONE"
          ? normalizeGitHubMilestone(reference.repositoryId, result.value)
          : normalizeGitHubIssue(reference.repositoryId, result.value);
    const updated = (result.value as any)?.updated_at ?? digest(result.value);
    return {
      ok: true,
      value: observed(scope, githubReferenceKey(reference), value, String(updated), input.clock),
    };
  };
  return {
    inspect,
    async mutate(
      authorization: ConnectorOperationAuthorization,
      command: ExactRevisionMutation<GitHubMutation>,
    ) {
      if (
        authorization.operation !== command.mutation.kind ||
        authorization.actionDigest !== command.actionDigest ||
        authorization.connectorEpoch !== command.connectorEpoch
      )
        return failure("CONNECTOR_AUTHORIZATION_INVALID");
      const scope: ConnectorScope = {
        projectId: command.projectId,
        connectorId: command.connectorId,
        connectorEpoch: command.connectorEpoch,
        references: [authorization.reference],
        operations: [authorization.operation],
      };
      const mutation = command.mutation;
      const repositoryId =
        "repository" in mutation
          ? mutation.repository.repositoryId
          : "issue" in mutation
            ? mutation.issue.repositoryId
            : "milestone" in mutation
              ? mutation.milestone.repositoryId
              : "item" in mutation
                ? mutation.item.repositoryId
                : undefined;
      if (repositoryId) {
        const metadata = repo(repositoryId);
        if (!metadata.ok) return metadata;
        const root = `/repos/${encodeURIComponent(metadata.value.owner)}/${encodeURIComponent(metadata.value.name)}`;
        let path = root;
        let method = "PATCH";
        let body: Record<string, unknown> = {};
        if (mutation.kind === "CREATE_ISSUE") {
          path += "/issues";
          method = "POST";
          body = { title: mutation.title, body: mutation.body };
        } else if (mutation.kind === "CREATE_MILESTONE") {
          path += "/milestones";
          method = "POST";
          body = {
            title: mutation.title,
            description: mutation.description,
            due_on: mutation.dueOn,
          };
        } else if (mutation.kind === "EDIT_MILESTONE") {
          path += `/milestones/${mutation.milestone.number}`;
          body = {
            ...(mutation.title === undefined ? {} : { title: mutation.title }),
            ...(mutation.description === undefined ? {} : { description: mutation.description }),
            ...(mutation.dueOn === undefined ? {} : { due_on: mutation.dueOn }),
            ...(mutation.state === undefined ? {} : { state: mutation.state.toLowerCase() }),
          };
        } else {
          const work =
            "issue" in mutation
              ? mutation.issue
              : mutation.kind === "SET_MILESTONE"
                ? mutation.item
                : null;
          if (!work) return failure("GITHUB_OPERATION_UNSUPPORTED");
          path += `/issues/${work.number}`;
          if (mutation.kind === "ADD_COMMENT") {
            path += "/comments";
            method = "POST";
            body = { body: mutation.body };
          } else if (mutation.kind === "EDIT_ISSUE")
            body = {
              ...(mutation.title === undefined ? {} : { title: mutation.title }),
              ...(mutation.body === undefined ? {} : { body: mutation.body }),
            };
          else if (mutation.kind === "SET_LABELS") body = { labels: mutation.labels };
          else if (mutation.kind === "SET_ASSIGNEES") body = { assignees: mutation.logins };
          else if (mutation.kind === "SET_MILESTONE")
            body = { milestone: mutation.milestoneNumber };
          else if (mutation.kind === "SET_ISSUE_STATE")
            body = {
              state: mutation.state.toLowerCase(),
              state_reason: mutation.reason.toLowerCase(),
            };
        }
        const written = await request(scope, path, { method, body: JSON.stringify(body) });
        if (!written.ok) return written;
        if (mutation.kind === "ADD_COMMENT") return inspect(scope, mutation.issue);
        const value = mutation.kind.includes("MILESTONE")
          ? normalizeGitHubMilestone(repositoryId, written.value)
          : normalizeGitHubIssue(repositoryId, written.value);
        const ref: GitHubReference =
          value.kind === "MILESTONE"
            ? { kind: "MILESTONE", repositoryId, number: value.number }
            : value.kind === "ISSUE"
              ? { kind: "ISSUE", repositoryId, number: value.number }
              : { kind: "ISSUE", repositoryId, number: 1 };
        const result = observed(
          scope,
          githubReferenceKey(ref),
          value,
          String((written.value as any)?.updated_at ?? digest(written.value)),
          input.clock,
        );
        return {
          ok: true,
          value: { ...result, provenance: { ...result.provenance, kind: "MUTATION_CONFIRMATION" } },
        };
      }
      const project = "project" in mutation ? mutation.project : null;
      if (!project) return failure("GITHUB_OPERATION_UNSUPPORTED");
      const documents: Record<string, string> = {
        ADD_PROJECT_ITEM:
          "mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}",
        REMOVE_PROJECT_ITEM:
          "mutation($project:ID!,$item:ID!){deleteProjectV2Item(input:{projectId:$project,itemId:$item}){deletedItemId}}",
        SET_PROJECT_FIELD:
          "mutation($project:ID!,$item:ID!,$field:ID!,$value:ProjectV2FieldValue!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:$value}){projectV2Item{id}}}",
        MOVE_PROJECT_ITEM:
          "mutation($project:ID!,$item:ID!,$after:ID){updateProjectV2ItemPosition(input:{projectId:$project,itemId:$item,afterId:$after}){items{nodes{id}}}}",
      };
      const variables: Record<string, unknown> = { project: project.projectNodeId };
      if (mutation.kind === "ADD_PROJECT_ITEM") {
        const nodeId = input.workItemNodeId(mutation.item);
        if (!nodeId.ok) return nodeId;
        variables.content = nodeId.value;
      }
      if (
        mutation.kind === "REMOVE_PROJECT_ITEM" ||
        mutation.kind === "SET_PROJECT_FIELD" ||
        mutation.kind === "MOVE_PROJECT_ITEM"
      )
        variables.item = mutation.itemId;
      if (mutation.kind === "SET_PROJECT_FIELD") {
        variables.field = mutation.fieldId;
        variables.value =
          mutation.value.kind === "TEXT"
            ? { text: mutation.value.value }
            : mutation.value.kind === "NUMBER"
              ? { number: mutation.value.value }
              : mutation.value.kind === "DATE"
                ? { date: mutation.value.value }
                : mutation.value.kind === "SINGLE_SELECT"
                  ? { singleSelectOptionId: mutation.value.optionId }
                  : mutation.value.kind === "ITERATION"
                    ? { iterationId: mutation.value.iterationId }
                    : {};
      }
      if (mutation.kind === "MOVE_PROJECT_ITEM") variables.after = mutation.afterItemId;
      const written = await request(scope, "/graphql", {
        method: "POST",
        body: JSON.stringify({ query: documents[mutation.kind], variables }),
      });
      if (!written.ok) return written;
      const confirmed = await inspect(scope, project);
      return confirmed.ok
        ? {
            ok: true,
            value: {
              ...confirmed.value,
              provenance: { ...confirmed.value.provenance, kind: "MUTATION_CONFIRMATION" },
            },
          }
        : confirmed;
    },
    async *scan(
      scope: ConnectorScope,
      _cursor?: ReconciliationCursor,
    ): AsyncIterable<Result<ReconciliationEvent<GitHubProjection>>> {
      for (const repositoryId of input.selectedRepositoryIds(scope)) {
        const metadata = repo(repositoryId);
        if (!metadata.ok) {
          yield metadata;
          return;
        }
        const result = await request(
          scope,
          `/repos/${encodeURIComponent(metadata.value.owner)}/${encodeURIComponent(metadata.value.name)}/issues?state=all&per_page=100`,
        );
        if (!result.ok) {
          yield result;
          return;
        }
        if (!Array.isArray(result.value)) {
          yield failure("GITHUB_RESPONSE_INVALID");
          return;
        }
        for (const payload of result.value) {
          if ((payload as any).pull_request) continue;
          const value = normalizeGitHubIssue(repositoryId, payload);
          if (value.kind !== "ISSUE") continue;
          const reference = `ISSUE:${repositoryId}:${value.number}`;
          const sourceRevision = String((payload as any).updated_at ?? digest(payload));
          yield {
            ok: true,
            value: {
              projectId: scope.projectId,
              connectorId: scope.connectorId,
              connectorEpoch: scope.connectorEpoch,
              idempotencyKey: `github_${repositoryId}_${value.number}_${digest(sourceRevision).slice(0, 32)}`,
              reference,
              sourceRevision,
              comparableDigest: digest(value) as never,
              observedAt: input.clock(),
              freshness: "FRESH",
              provenance: { kind: "RECONCILIATION" },
              value,
            },
          };
        }
      }
    },
    async observeChecks(scope: ConnectorScope, reference: PublishedGitReference) {
      const metadata = repo(reference.remoteIdentity);
      if (!metadata.ok) return metadata;
      const result = await request(
        scope,
        `/repos/${encodeURIComponent(metadata.value.owner)}/${encodeURIComponent(metadata.value.name)}/commits/${reference.commitSha}/check-runs`,
      );
      if (!result.ok) return result;
      const checks = Array.isArray((result.value as any)?.check_runs)
        ? (result.value as any).check_runs.map(
            (item: any): GitHubCheckObservation => ({
              checkRunId: String(item.id),
              repositoryId: metadata.value.repositoryId,
              commitSha: String(item.head_sha),
              checkName: String(item.name),
              status: checkStatus(item.status),
              conclusion: checkConclusion(item.conclusion),
              scopeDigest: digest(scope.references) as never,
              observedAt: input.clock(),
              fresh: true,
            }),
          )
        : [];
      return {
        ok: true,
        value: {
          value: checks,
          reference: `CHECKS:${metadata.value.repositoryId}:${reference.commitSha}`,
          sourceRevision: reference.commitSha,
          comparableDigest: digest(checks) as never,
          projectionRevision: 0,
          observedAt: input.clock(),
          freshness: "FRESH",
          provenance: {
            projectId: scope.projectId,
            connectorId: scope.connectorId,
            connectorEpoch: scope.connectorEpoch,
            kind: "RECONCILIATION",
          },
        },
      };
    },
    async listDependencies(scope: ConnectorScope, reference: GitHubWorkItemReference) {
      const value: readonly SourceDependency[] = [];
      return {
        ok: true,
        value: {
          value,
          reference: `DEPENDENCIES:${githubReferenceKey(reference)}`,
          sourceRevision: "NOT_SUPPORTED",
          comparableDigest: digest(value) as never,
          projectionRevision: 0,
          observedAt: input.clock(),
          freshness: "UNAVAILABLE",
          provenance: {
            projectId: scope.projectId,
            connectorId: scope.connectorId,
            connectorEpoch: scope.connectorEpoch,
            kind: "RECONCILIATION",
          },
        },
      };
    },
  };
}
