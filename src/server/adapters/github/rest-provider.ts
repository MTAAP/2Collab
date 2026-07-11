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
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

function replaceTarget(mutation: GitHubMutation): GitHubReference | null {
  switch (mutation.kind) {
    case "EDIT_ISSUE":
    case "SET_LABELS":
    case "SET_ASSIGNEES":
    case "SET_ISSUE_STATE":
      return mutation.issue;
    case "SET_MILESTONE":
      return mutation.item;
    case "EDIT_MILESTONE":
      return mutation.milestone;
    case "REMOVE_PROJECT_ITEM":
    case "SET_PROJECT_FIELD":
    case "MOVE_PROJECT_ITEM":
      return mutation.project;
    default:
      return null;
  }
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
      const value = text ? JSON.parse(text) : {};
      if (
        path === "/graphql" &&
        typeof value === "object" &&
        value !== null &&
        Array.isArray((value as Record<string, unknown>).errors) &&
        ((value as Record<string, unknown>).errors as unknown[]).length > 0
      )
        return failure("GITHUB_GRAPHQL_FAILED", "REFRESH");
      return { ok: true, value };
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
      let title: string | undefined;
      const fieldNodes: unknown[] = [];
      const itemNodes: unknown[] = [];
      const responses: unknown[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 100; page += 1) {
        const result = await request(scope, "/graphql", {
          method: "POST",
          body: JSON.stringify({
            query:
              "query CollabSelectedProjectFields($id:ID!,$after:String){node(id:$id){... on ProjectV2{id title fields(first:100,after:$after){nodes{... on ProjectV2Field{id name dataType} ... on ProjectV2SingleSelectField{id name dataType options{id}} ... on ProjectV2IterationField{id name dataType configuration{iterations{id}}}} pageInfo{hasNextPage endCursor}}}}}",
            variables: { id: reference.projectNodeId, after: cursor },
          }),
        });
        if (!result.ok) return result;
        responses.push(result.value);
        const node = record(record(record(result.value)?.data)?.node);
        if (!node) return failure("GITHUB_MISSING");
        title ??= String(node.title);
        const fieldsPage = record(node.fields);
        if (!Array.isArray(fieldsPage?.nodes)) return failure("GITHUB_RESPONSE_INVALID");
        fieldNodes.push(...fieldsPage.nodes);
        const pageInfo = record(fieldsPage.pageInfo);
        if (!pageInfo?.hasNextPage) break;
        if (typeof pageInfo.endCursor !== "string") return failure("GITHUB_RESPONSE_INVALID");
        cursor = pageInfo.endCursor;
        if (page === 99) return failure("GITHUB_PAGINATION_LIMIT");
      }
      cursor = null;
      for (let page = 0; page < 100; page += 1) {
        const result = await request(scope, "/graphql", {
          method: "POST",
          body: JSON.stringify({
            query:
              "query CollabSelectedProjectItems($id:ID!,$after:String){node(id:$id){... on ProjectV2{items(first:100,after:$after){nodes{id content{... on Issue{number repository{databaseId}} ... on PullRequest{number repository{databaseId}}}} pageInfo{hasNextPage endCursor}}}}}",
            variables: { id: reference.projectNodeId, after: cursor },
          }),
        });
        if (!result.ok) return result;
        responses.push(result.value);
        const node = record(record(record(result.value)?.data)?.node);
        if (!node) return failure("GITHUB_MISSING");
        const itemsPage = record(node.items);
        if (!Array.isArray(itemsPage?.nodes)) return failure("GITHUB_RESPONSE_INVALID");
        itemNodes.push(...itemsPage.nodes);
        const pageInfo = record(itemsPage.pageInfo);
        if (!pageInfo?.hasNextPage) break;
        if (typeof pageInfo.endCursor !== "string") return failure("GITHUB_RESPONSE_INVALID");
        cursor = pageInfo.endCursor;
        if (page === 99) return failure("GITHUB_PAGINATION_LIMIT");
      }
      const items = itemNodes.map((candidate) => {
        const item = record(candidate) ?? {};
        const content = record(item.content);
        const repository = record(content?.repository);
        return {
          itemId: String(item.id),
          repositoryId: repository?.databaseId ? String(repository.databaseId) : undefined,
          number: typeof content?.number === "number" ? content.number : undefined,
          title: "",
        };
      });
      const fields = fieldNodes.map((candidate) => {
        const field = record(candidate) ?? {};
        const configuration = record(field.configuration);
        const iterations = Array.isArray(configuration?.iterations) ? configuration.iterations : [];
        return {
          id: String(field.id),
          name: String(field.name),
          dataType: String(field.dataType),
          optionIds: Array.isArray(field.options)
            ? field.options.map((option) => String(record(option)?.id))
            : iterations.map((iteration) => String(record(iteration)?.id)),
        };
      });
      const value = normalizeSelectedGitHubProject({
        projectNodeId: reference.projectNodeId,
        title: title ?? "",
        selectedRepositoryIds: new Set(input.selectedRepositoryIds(scope)),
        items,
        fields,
      });
      return {
        ok: true,
        value: observed(
          scope,
          githubReferenceKey(reference),
          value,
          digest(responses),
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
    const updated = record(result.value)?.updated_at ?? digest(result.value);
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
      const replaceReference = replaceTarget(mutation);
      if (replaceReference && command.precondition.kind !== "ABSENT") {
        const refreshed = await inspect(scope, replaceReference);
        if (!refreshed.ok) return refreshed;
        if (
          refreshed.value.sourceRevision !== command.precondition.sourceRevision ||
          refreshed.value.comparableDigest !== command.precondition.comparableDigest
        )
          return failure("SOURCE_REVISION_STALE", "REFRESH");
      }
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
          String(record(written.value)?.updated_at ?? digest(written.value)),
          input.clock,
        );
        return {
          ok: true,
          value: {
            ...result,
            consistency: "RESIDUAL_RACE",
            provenance: { ...result.provenance, kind: "MUTATION_CONFIRMATION" },
          },
        };
      }
      const project = "project" in mutation ? mutation.project : null;
      if (!project) return failure("GITHUB_OPERATION_UNSUPPORTED");
      const refreshedProject = await inspect(scope, project);
      if (!refreshedProject.ok) return refreshedProject;
      if (refreshedProject.value.value.kind !== "PROJECT")
        return failure("GITHUB_PROJECT_UNAVAILABLE", "REFRESH");
      const selectedRepositories = new Set(input.selectedRepositoryIds(scope));
      if (
        mutation.kind === "ADD_PROJECT_ITEM" &&
        !selectedRepositories.has(mutation.item.repositoryId)
      )
        return failure("GITHUB_REPOSITORY_NOT_SELECTED");
      if (
        (mutation.kind === "REMOVE_PROJECT_ITEM" ||
          mutation.kind === "SET_PROJECT_FIELD" ||
          mutation.kind === "MOVE_PROJECT_ITEM") &&
        !refreshedProject.value.value.items.some((item) => item.itemId === mutation.itemId)
      )
        return failure("GITHUB_PROJECT_ITEM_NOT_ELIGIBLE", "REFRESH");
      if (mutation.kind === "SET_PROJECT_FIELD") {
        const field = refreshedProject.value.value.fields.find(
          (candidate) => candidate.id === mutation.fieldId,
        );
        if (!field) return failure("GITHUB_PROJECT_FIELD_NOT_ELIGIBLE", "REFRESH");
        const optionId =
          mutation.value.kind === "SINGLE_SELECT"
            ? mutation.value.optionId
            : mutation.value.kind === "ITERATION"
              ? mutation.value.iterationId
              : null;
        if (optionId && !field.optionIds.includes(optionId))
          return failure("GITHUB_PROJECT_OPTION_NOT_ELIGIBLE", "REFRESH");
      }
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
      if (mutation.kind === "SET_PROJECT_FIELD" && mutation.value.kind === "CLEAR")
        documents.SET_PROJECT_FIELD =
          "mutation($project:ID!,$item:ID!,$field:ID!){clearProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field}){projectV2Item{id}}}";
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
        if (mutation.value.kind !== "CLEAR")
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
              consistency: "RESIDUAL_RACE",
              provenance: { ...confirmed.value.provenance, kind: "MUTATION_CONFIRMATION" },
            },
          }
        : confirmed;
    },
    async *scan(
      scope: ConnectorScope,
      _cursor?: ReconciliationCursor,
    ): AsyncIterable<Result<ReconciliationEvent<GitHubProjection>>> {
      let resume: Readonly<{ family?: string; repositoryId?: string; page?: number }> = {};
      if (_cursor) {
        try {
          const parsed = JSON.parse(_cursor) as Record<string, unknown>;
          resume = {
            family: typeof parsed.family === "string" ? parsed.family : undefined,
            repositoryId: typeof parsed.repositoryId === "string" ? parsed.repositoryId : undefined,
            page: typeof parsed.page === "number" && parsed.page > 0 ? parsed.page : undefined,
          };
        } catch {
          yield failure("GITHUB_CURSOR_INVALID");
          return;
        }
      }
      for (const repositoryId of input.selectedRepositoryIds(scope)) {
        if (resume.repositoryId && repositoryId !== resume.repositoryId) continue;
        const metadata = repo(repositoryId);
        if (!metadata.ok) {
          yield metadata;
          return;
        }
        const root = `/repos/${encodeURIComponent(metadata.value.owner)}/${encodeURIComponent(metadata.value.name)}`;
        for (const family of ["ISSUES", "PULL_REQUESTS", "MILESTONES"] as const) {
          if (resume.family && family !== resume.family) continue;
          for (let page = resume.page ?? 1; page <= 100; page += 1) {
            const endpoint =
              family === "ISSUES"
                ? `${root}/issues?state=all&per_page=100&page=${page}`
                : family === "PULL_REQUESTS"
                  ? `${root}/pulls?state=all&per_page=100&page=${page}`
                  : `${root}/milestones?state=all&per_page=100&page=${page}`;
            const result = await request(scope, endpoint);
            if (!result.ok) {
              yield result;
              return;
            }
            if (!Array.isArray(result.value)) {
              yield failure("GITHUB_RESPONSE_INVALID");
              return;
            }
            for (const payload of result.value) {
              if (family === "ISSUES" && (payload as Record<string, unknown>).pull_request)
                continue;
              const value =
                family === "ISSUES"
                  ? normalizeGitHubIssue(repositoryId, payload)
                  : family === "PULL_REQUESTS"
                    ? normalizeGitHubPullRequest(repositoryId, payload)
                    : normalizeGitHubMilestone(repositoryId, payload);
              const reference =
                value.kind === "ISSUE"
                  ? `ISSUE:${repositoryId}:${value.number}`
                  : value.kind === "PULL_REQUEST"
                    ? `PULL_REQUEST:${repositoryId}:${value.number}`
                    : value.kind === "MILESTONE"
                      ? `MILESTONE:${repositoryId}:${value.number}`
                      : null;
              if (!reference) continue;
              const sourceRevision = String(
                (payload as Record<string, unknown>).updated_at ?? digest(payload),
              );
              yield {
                ok: true,
                value: {
                  projectId: scope.projectId,
                  connectorId: scope.connectorId,
                  connectorEpoch: scope.connectorEpoch,
                  idempotencyKey: `github_${family}_${repositoryId}_${digest(`${reference}:${sourceRevision}`).slice(0, 32)}`,
                  reference,
                  actionMarker: JSON.stringify({ family, repositoryId, page }),
                  sourceRevision,
                  comparableDigest: digest(value) as never,
                  observedAt: input.clock(),
                  freshness: "FRESH",
                  provenance: { kind: "RECONCILIATION" },
                  value,
                },
              };
            }
            if (result.value.length < 100) break;
          }
          resume = {};
        }
      }
      for (const projectNodeId of input.selectedProjectIds(scope)) {
        const project = await inspect(scope, { kind: "PROJECT", projectNodeId });
        if (!project.ok) {
          yield project;
          return;
        }
        yield {
          ok: true,
          value: {
            projectId: scope.projectId,
            connectorId: scope.connectorId,
            connectorEpoch: scope.connectorEpoch,
            idempotencyKey: `github_PROJECT_${digest(project.value.sourceRevision).slice(0, 32)}`,
            reference: project.value.reference,
            actionMarker: JSON.stringify({ family: "PROJECTS", projectNodeId, page: 1 }),
            sourceRevision: project.value.sourceRevision,
            comparableDigest: project.value.comparableDigest,
            observedAt: project.value.observedAt,
            freshness: project.value.freshness,
            provenance: { kind: "RECONCILIATION" },
            value: project.value.value,
          },
        };
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
      const checkRuns = record(result.value)?.check_runs;
      const checks = Array.isArray(checkRuns)
        ? checkRuns.map((candidate): GitHubCheckObservation => {
            const item = record(candidate) ?? {};
            return {
              checkRunId: String(item.id),
              repositoryId: metadata.value.repositoryId,
              commitSha: String(item.head_sha),
              checkName: String(item.name),
              status: checkStatus(item.status),
              conclusion: checkConclusion(item.conclusion),
              scopeDigest: digest(scope.references) as never,
              observedAt: input.clock(),
              fresh: true,
            };
          })
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
