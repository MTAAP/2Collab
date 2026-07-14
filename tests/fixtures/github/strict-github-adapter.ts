import type { PublishedGitReference } from "../../../src/shared/contracts/runs.ts";
import type { Result } from "../../../src/shared/contracts/result.ts";
import {
  githubReferenceKey,
  type GitHubCheckObservation,
  type GitHubIssueRef,
  type GitHubMutation,
  type GitHubProjection,
  type GitHubReference,
  type GitHubWorkItemReference,
  type SourceDependency,
} from "../../../src/shared/contracts/github.ts";
import type { GitHubPort } from "../../../src/server/adapters/github/contract.ts";
import { assertGitHubScope } from "../../../src/server/adapters/github/scope.ts";
import type {
  ConnectorOperationAuthorization,
  ConnectorScope,
  ExactRevisionMutation,
  Observed,
  ReconciliationCursor,
  ReconciliationEvent,
} from "../../../src/server/modules/connectors/contract.ts";

export type GitHubOperationKind = GitHubMutation["kind"] | "INSPECT" | "SCAN" | "CHECKS";
export type GitHubFixtureFault =
  | "RATE_LIMITED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "LOST_RESPONSE"
  | "UNAVAILABLE";

export type GitHubCall = Readonly<{
  kind: GitHubOperationKind;
  reference: string;
  connectorEpoch: number;
}>;

export type GitHubFixtureSeed = Readonly<{
  connectorId: string;
  connectorEpoch: number;
  selectedRepositoryIds: readonly string[];
  providerRepositoryIds?: readonly string[];
  selectedProjectIds: readonly string[];
  providerPermissions?: Readonly<Record<string, "read" | "write">>;
}>;

type Issue = {
  repositoryId: string;
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  stateReason: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED" | null;
  labels: string[];
  assignees: string[];
  milestoneNumber: number | null;
  comments: Array<{ id: string; body: string; marker: string }>;
  revision: number;
};
type Milestone = {
  repositoryId: string;
  number: number;
  title: string;
  description: string;
  dueOn: string | null;
  state: "OPEN" | "CLOSED";
  revision: number;
};
type ProjectItem = {
  itemId: string;
  repositoryId: string;
  number: number;
  title: string;
  kind: "ISSUE" | "PULL_REQUEST";
  fieldValues: Record<string, string | number | boolean | null>;
};
type Project = { title: string; items: ProjectItem[]; revision: number };

function failure(code: string, retry: "NEVER" | "REFRESH" | "SAME_INPUT" = "NEVER"): Result<never> {
  return { ok: false, error: { code, message: "GitHub operation failed.", retry } };
}

function sha256(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
}

function mutationReference(mutation: GitHubMutation): GitHubReference {
  switch (mutation.kind) {
    case "CREATE_ISSUE":
      return { kind: "ISSUE", repositoryId: mutation.repository.repositoryId, number: 1 };
    case "EDIT_ISSUE":
    case "ADD_COMMENT":
    case "SET_LABELS":
    case "SET_ASSIGNEES":
    case "SET_ISSUE_STATE":
      return mutation.issue;
    case "SET_MILESTONE":
      return mutation.item;
    case "CREATE_MILESTONE":
      return { kind: "MILESTONE", repositoryId: mutation.repository.repositoryId, number: 1 };
    case "EDIT_MILESTONE":
      return mutation.milestone;
    case "ADD_PROJECT_ITEM":
    case "REMOVE_PROJECT_ITEM":
    case "SET_PROJECT_FIELD":
    case "MOVE_PROJECT_ITEM":
      return mutation.project;
  }
}

function projectionReference(
  projection: GitHubProjection,
  fallback: GitHubReference,
): GitHubReference {
  if (projection.kind === "ISSUE") {
    return {
      kind: "ISSUE",
      repositoryId: projection.repositoryId,
      number: projection.number,
    };
  }
  if (projection.kind === "PULL_REQUEST") {
    return {
      kind: "PULL_REQUEST",
      repositoryId: projection.repositoryId,
      number: projection.number,
    };
  }
  if (projection.kind === "MILESTONE") {
    return {
      kind: "MILESTONE",
      repositoryId: projection.repositoryId,
      number: projection.number,
    };
  }
  if (projection.kind === "PROJECT") {
    return { kind: "PROJECT", projectNodeId: projection.projectNodeId };
  }
  return fallback;
}

export class StrictGitHubAdapter implements GitHubPort {
  readonly calls: GitHubCall[] = [];
  readonly events: string[] = [];
  private connectorEpoch: number;
  private readonly connectorId: string;
  private selectedRepositoryIds: Set<string>;
  private readonly providerRepositoryIds: Set<string>;
  private readonly selectedProjectIds: Set<string>;
  private readonly providerPermissions: Readonly<Record<string, "read" | "write">>;
  private readonly issues = new Map<string, Issue>();
  private readonly milestones = new Map<string, Milestone>();
  private readonly projects = new Map<string, Project>();
  private readonly checks = new Map<string, GitHubCheckObservation[]>();
  private readonly dependencies = new Map<string, SourceDependency[]>();
  private readonly faults = new Map<GitHubOperationKind, GitHubFixtureFault>();
  private confirmationHook: (() => void) | undefined;

  private constructor(seed: GitHubFixtureSeed) {
    this.connectorId = seed.connectorId;
    this.connectorEpoch = seed.connectorEpoch;
    this.selectedRepositoryIds = new Set(seed.selectedRepositoryIds);
    this.providerRepositoryIds = new Set(seed.providerRepositoryIds ?? seed.selectedRepositoryIds);
    this.selectedProjectIds = new Set(seed.selectedProjectIds);
    this.providerPermissions = seed.providerPermissions ?? {
      issues: "write",
      pull_requests: "read",
      checks: "read",
      organization_projects: "write",
    };
    for (const project of seed.selectedProjectIds) {
      this.projects.set(project, { title: project, items: [], revision: 1 });
    }
  }

  static seed(seed: GitHubFixtureSeed): StrictGitHubAdapter {
    return new StrictGitHubAdapter(seed);
  }

  failNext(kind: GitHubOperationKind, fault: GitHubFixtureFault): void {
    this.faults.set(kind, fault);
  }

  beforeNextConfirmation(callback: () => void): void {
    this.confirmationHook = callback;
  }

  narrowScope(input: Readonly<{ repositoryIds: readonly string[]; connectorEpoch: number }>): void {
    this.selectedRepositoryIds = new Set(input.repositoryIds);
    this.connectorEpoch = input.connectorEpoch;
  }

  addIssue(
    input: Readonly<{ repositoryId: string; number: number; title: string; body?: string }>,
  ): void {
    this.issues.set(`${input.repositoryId}:${input.number}`, {
      ...input,
      body: input.body ?? "",
      state: "OPEN",
      stateReason: null,
      labels: [],
      assignees: [],
      milestoneNumber: null,
      comments: [],
      revision: 1,
    });
  }

  replaceIssue(input: Readonly<{ repositoryId: string; number: number; title: string }>): void {
    const issue = this.issues.get(`${input.repositoryId}:${input.number}`);
    if (!issue) throw new Error("FIXTURE_ISSUE_NOT_FOUND");
    issue.title = input.title;
    issue.revision += 1;
  }

  addProjectItem(
    projectNodeId: string,
    input: Readonly<{
      itemId: string;
      repositoryId: string;
      number: number;
      title: string;
      kind?: "ISSUE" | "PULL_REQUEST";
    }>,
  ): void {
    const project = this.projects.get(projectNodeId);
    if (!project) throw new Error("FIXTURE_PROJECT_NOT_FOUND");
    project.items.push({ ...input, kind: input.kind ?? "ISSUE", fieldValues: {} });
    project.revision += 1;
  }

  setChecks(commitSha: string, checks: readonly GitHubCheckObservation[]): void {
    this.checks.set(commitSha, [...checks]);
  }

  setDependencies(
    reference: GitHubWorkItemReference,
    dependencies: readonly SourceDependency[],
  ): void {
    this.dependencies.set(githubReferenceKey(reference), [...dependencies]);
  }

  private scope(
    scope: ConnectorScope,
    reference: GitHubReference,
    permission?: Readonly<{ name: string; level: "read" | "write" }>,
  ): Result<unknown> {
    const repositoryId = reference.kind === "PROJECT" ? undefined : reference.repositoryId;
    const projectNodeId = reference.kind === "PROJECT" ? reference.projectNodeId : undefined;
    if (scope.connectorId !== this.connectorId) return failure("CONNECTOR_REVOKED", "REFRESH");
    return assertGitHubScope({
      connectorId: this.connectorId,
      connectorEpoch: scope.connectorEpoch,
      expectedConnectorEpoch: this.connectorEpoch,
      selectedRepositoryIds: this.selectedRepositoryIds,
      providerRepositoryIds: this.providerRepositoryIds,
      selectedProjectIds: this.selectedProjectIds,
      repositoryId,
      projectNodeId,
      providerPermissions: this.providerPermissions,
      requiredPermission: permission,
    });
  }

  private consumeFault(kind: GitHubOperationKind): Result<never> | null {
    const fault = this.faults.get(kind);
    if (!fault) return null;
    this.faults.delete(kind);
    if (fault === "RATE_LIMITED") return failure("GITHUB_RATE_LIMITED", "SAME_INPUT");
    if (fault === "FORBIDDEN") return failure("GITHUB_FORBIDDEN");
    if (fault === "NOT_FOUND") return failure("GITHUB_MISSING", "REFRESH");
    if (fault === "UNAVAILABLE") return failure("GITHUB_UNAVAILABLE", "SAME_INPUT");
    return failure("GITHUB_RESULT_AMBIGUOUS", "REFRESH");
  }

  private issueProjection(issue: Issue): GitHubProjection {
    return {
      kind: "ISSUE",
      repositoryId: issue.repositoryId,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      stateReason: issue.stateReason,
      labels: issue.labels,
      assignees: issue.assignees,
      milestoneNumber: issue.milestoneNumber,
      commentCount: issue.comments.length,
    };
  }

  private milestoneProjection(milestone: Milestone): GitHubProjection {
    let openIssues = 0;
    let closedIssues = 0;
    for (const issue of this.issues.values()) {
      if (
        issue.repositoryId !== milestone.repositoryId ||
        issue.milestoneNumber !== milestone.number
      )
        continue;
      if (issue.state === "OPEN") openIssues += 1;
      else closedIssues += 1;
    }
    return { ...milestone, kind: "MILESTONE", openIssues, closedIssues };
  }

  private projectProjection(projectNodeId: string, project: Project): GitHubProjection {
    const supported = project.items.filter((item) =>
      this.selectedRepositoryIds.has(item.repositoryId),
    );
    return {
      kind: "PROJECT",
      projectNodeId,
      title: project.title,
      itemCount: supported.length,
      unsupportedRepositoryItems: project.items.length - supported.length,
      fields: [],
      items: supported.map((item) => ({
        itemId: item.itemId,
        content: {
          kind: item.kind,
          repositoryId: item.repositoryId,
          number: item.number,
        },
      })),
    };
  }

  private observed(
    scope: ConnectorScope,
    reference: GitHubReference,
    value: GitHubProjection,
    revision: number,
  ): Observed<GitHubProjection> {
    return {
      value,
      reference: githubReferenceKey(reference),
      sourceRevision: `v${revision}`,
      comparableDigest: sha256(value) as never,
      projectionRevision: 0,
      observedAt: Date.now(),
      freshness: value.kind === "REDACTED" ? "REDACTED" : "FRESH",
      provenance: {
        projectId: scope.projectId,
        connectorId: scope.connectorId,
        connectorEpoch: scope.connectorEpoch,
        kind: "RECONCILIATION",
      },
    };
  }

  async inspect(
    scope: ConnectorScope,
    reference: GitHubReference,
  ): Promise<Result<Observed<GitHubProjection>>> {
    const allowed = this.scope(scope, reference, {
      name:
        reference.kind === "PROJECT"
          ? "organization_projects"
          : reference.kind === "PULL_REQUEST"
            ? "pull_requests"
            : "issues",
      level: "read",
    });
    if (!allowed.ok) return allowed;
    this.calls.push({
      kind: "INSPECT",
      reference: githubReferenceKey(reference),
      connectorEpoch: scope.connectorEpoch,
    });
    const fault = this.consumeFault("INSPECT");
    if (fault) return fault;
    this.confirmationHook?.();
    this.confirmationHook = undefined;
    const confirmed = this.scope(scope, reference);
    if (!confirmed.ok) return confirmed;
    if (reference.kind === "ISSUE") {
      const issue = this.issues.get(`${reference.repositoryId}:${reference.number}`);
      return issue
        ? {
            ok: true,
            value: this.observed(scope, reference, this.issueProjection(issue), issue.revision),
          }
        : failure("GITHUB_MISSING", "REFRESH");
    }
    if (reference.kind === "MILESTONE") {
      const milestone = this.milestones.get(`${reference.repositoryId}:${reference.number}`);
      return milestone
        ? {
            ok: true,
            value: this.observed(
              scope,
              reference,
              this.milestoneProjection(milestone),
              milestone.revision,
            ),
          }
        : failure("GITHUB_MISSING", "REFRESH");
    }
    if (reference.kind === "PROJECT") {
      const project = this.projects.get(reference.projectNodeId);
      return project
        ? {
            ok: true,
            value: this.observed(
              scope,
              reference,
              this.projectProjection(reference.projectNodeId, project),
              project.revision,
            ),
          }
        : failure("GITHUB_MISSING", "REFRESH");
    }
    return failure("GITHUB_MISSING", "REFRESH");
  }

  async mutate(
    authorization: ConnectorOperationAuthorization,
    command: ExactRevisionMutation<GitHubMutation>,
  ): Promise<Result<Observed<GitHubProjection>>> {
    const mutation = command.mutation;
    const reference = mutationReference(mutation);
    const scope: ConnectorScope = {
      projectId: command.projectId,
      connectorId: command.connectorId,
      connectorEpoch: command.connectorEpoch,
      references: [githubReferenceKey(reference)],
      operations: [mutation.kind],
    };
    if (
      authorization.projectId !== command.projectId ||
      authorization.connectorId !== command.connectorId ||
      authorization.connectorEpoch !== command.connectorEpoch ||
      authorization.operation !== mutation.kind ||
      authorization.actionDigest !== command.actionDigest
    )
      return failure("CONNECTOR_AUTHORIZATION_INVALID");
    const allowed = this.scope(scope, reference, {
      name: reference.kind === "PROJECT" ? "organization_projects" : "issues",
      level: "write",
    });
    if (!allowed.ok) return allowed;
    this.calls.push({
      kind: mutation.kind,
      reference: githubReferenceKey(reference),
      connectorEpoch: command.connectorEpoch,
    });
    this.events.push(`AUTHORIZED:${mutation.kind}`);
    const earlyFault = this.faults.get(mutation.kind);
    if (earlyFault && earlyFault !== "LOST_RESPONSE")
      return this.consumeFault(mutation.kind) as Result<never>;

    let projection: GitHubProjection;
    let revision: number;
    if (mutation.kind === "CREATE_ISSUE") {
      const next =
        Math.max(
          0,
          ...[...this.issues.values()]
            .filter((issue) => issue.repositoryId === mutation.repository.repositoryId)
            .map((issue) => issue.number),
        ) + 1;
      const issue: Issue = {
        repositoryId: mutation.repository.repositoryId,
        number: next,
        title: mutation.title,
        body: mutation.body,
        state: "OPEN",
        stateReason: null,
        labels: [],
        assignees: [],
        milestoneNumber: null,
        comments: [],
        revision: 1,
      };
      this.issues.set(`${issue.repositoryId}:${issue.number}`, issue);
      projection = this.issueProjection(issue);
      revision = issue.revision;
    } else if (
      ["EDIT_ISSUE", "ADD_COMMENT", "SET_LABELS", "SET_ASSIGNEES", "SET_ISSUE_STATE"].includes(
        mutation.kind,
      )
    ) {
      const issueRef = (
        mutation as Exclude<GitHubMutation, { kind: "CREATE_ISSUE" }> & { issue: GitHubIssueRef }
      ).issue;
      const issue = this.issues.get(`${issueRef.repositoryId}:${issueRef.number}`);
      if (!issue) return failure("GITHUB_MISSING", "REFRESH");
      if (
        command.precondition.kind === "EXACT_REVISION" &&
        (command.precondition.sourceRevision !== `v${issue.revision}` ||
          command.precondition.comparableDigest !== sha256(this.issueProjection(issue)))
      )
        return failure("SOURCE_REVISION_STALE", "REFRESH");
      if (mutation.kind === "EDIT_ISSUE") {
        if (mutation.title !== undefined) issue.title = mutation.title;
        if (mutation.body !== undefined) issue.body = mutation.body;
      }
      if (mutation.kind === "ADD_COMMENT")
        issue.comments.push({
          id: String(issue.comments.length + 1),
          body: mutation.body,
          marker: authorization.id,
        });
      if (mutation.kind === "SET_LABELS") issue.labels = [...mutation.labels];
      if (mutation.kind === "SET_ASSIGNEES") issue.assignees = [...mutation.logins];
      if (mutation.kind === "SET_ISSUE_STATE") {
        issue.state = mutation.state;
        issue.stateReason = mutation.reason;
      }
      issue.revision += 1;
      projection = this.issueProjection(issue);
      revision = issue.revision;
    } else if (mutation.kind === "SET_MILESTONE") {
      if (mutation.item.kind !== "ISSUE") return failure("GITHUB_OPERATION_UNSUPPORTED");
      const issue = this.issues.get(`${mutation.item.repositoryId}:${mutation.item.number}`);
      if (!issue) return failure("GITHUB_MISSING", "REFRESH");
      issue.milestoneNumber = mutation.milestoneNumber;
      issue.revision += 1;
      projection = this.issueProjection(issue);
      revision = issue.revision;
    } else if (mutation.kind === "CREATE_MILESTONE") {
      const next =
        Math.max(
          0,
          ...[...this.milestones.values()]
            .filter((item) => item.repositoryId === mutation.repository.repositoryId)
            .map((item) => item.number),
        ) + 1;
      const milestone: Milestone = {
        repositoryId: mutation.repository.repositoryId,
        number: next,
        title: mutation.title,
        description: mutation.description,
        dueOn: mutation.dueOn,
        state: "OPEN",
        revision: 1,
      };
      this.milestones.set(`${milestone.repositoryId}:${milestone.number}`, milestone);
      projection = this.milestoneProjection(milestone);
      revision = 1;
    } else if (mutation.kind === "EDIT_MILESTONE") {
      const milestone = this.milestones.get(
        `${mutation.milestone.repositoryId}:${mutation.milestone.number}`,
      );
      if (!milestone) return failure("GITHUB_MISSING", "REFRESH");
      if (mutation.title !== undefined) milestone.title = mutation.title;
      if (mutation.description !== undefined) milestone.description = mutation.description;
      if (mutation.dueOn !== undefined) milestone.dueOn = mutation.dueOn;
      if (mutation.state !== undefined) milestone.state = mutation.state;
      milestone.revision += 1;
      projection = this.milestoneProjection(milestone);
      revision = milestone.revision;
    } else {
      const projectMutation = mutation as Extract<
        GitHubMutation,
        {
          kind:
            | "ADD_PROJECT_ITEM"
            | "REMOVE_PROJECT_ITEM"
            | "SET_PROJECT_FIELD"
            | "MOVE_PROJECT_ITEM";
        }
      >;
      const project = this.projects.get(projectMutation.project.projectNodeId);
      if (!project) return failure("GITHUB_MISSING", "REFRESH");
      if (projectMutation.kind === "ADD_PROJECT_ITEM") {
        if (!this.selectedRepositoryIds.has(projectMutation.item.repositoryId))
          return failure("GITHUB_REPOSITORY_NOT_SELECTED");
        project.items.push({
          itemId: `PVTI_${project.items.length + 1}`,
          repositoryId: projectMutation.item.repositoryId,
          number: projectMutation.item.number,
          title: "",
          kind: projectMutation.item.kind,
          fieldValues: {},
        });
      } else if (projectMutation.kind === "REMOVE_PROJECT_ITEM")
        project.items = project.items.filter((item) => item.itemId !== projectMutation.itemId);
      else if (projectMutation.kind === "SET_PROJECT_FIELD") {
        const item = project.items.find((candidate) => candidate.itemId === projectMutation.itemId);
        if (!item || !this.selectedRepositoryIds.has(item.repositoryId))
          return failure("GITHUB_REPOSITORY_NOT_SELECTED");
        item.fieldValues[projectMutation.fieldId] =
          projectMutation.value.kind === "CLEAR"
            ? null
            : "value" in projectMutation.value
              ? projectMutation.value.value
              : "optionId" in projectMutation.value
                ? projectMutation.value.optionId
                : projectMutation.value.iterationId;
      } else {
        const index = project.items.findIndex((item) => item.itemId === projectMutation.itemId);
        if (index < 0) return failure("GITHUB_MISSING", "REFRESH");
        const [item] = project.items.splice(index, 1);
        if (!item) return failure("GITHUB_MISSING", "REFRESH");
        const after =
          projectMutation.afterItemId === null
            ? -1
            : project.items.findIndex(
                (candidate) => candidate.itemId === projectMutation.afterItemId,
              );
        project.items.splice(after + 1, 0, item);
      }
      project.revision += 1;
      projection = this.projectProjection(projectMutation.project.projectNodeId, project);
      revision = project.revision;
    }
    this.events.push(`PROVIDER_CONFIRMED:${mutation.kind}`);
    if (earlyFault === "LOST_RESPONSE") return this.consumeFault(mutation.kind) as Result<never>;
    return {
      ok: true,
      value: {
        ...this.observed(
          scope,
          projectionReference(projection, mutationReference(mutation)),
          projection,
          revision,
        ),
        provenance: {
          projectId: scope.projectId,
          connectorId: scope.connectorId,
          connectorEpoch: scope.connectorEpoch,
          kind: "MUTATION_CONFIRMATION",
        },
        consistency: "RESIDUAL_RACE",
      },
    };
  }

  async *scan(
    scope: ConnectorScope,
    _cursor?: ReconciliationCursor,
  ): AsyncIterable<Result<ReconciliationEvent<GitHubProjection>>> {
    const fault = this.consumeFault("SCAN");
    if (fault) {
      yield fault;
      return;
    }
    for (const issue of this.issues.values()) {
      if (!this.selectedRepositoryIds.has(issue.repositoryId)) continue;
      const reference = {
        kind: "ISSUE" as const,
        repositoryId: issue.repositoryId,
        number: issue.number,
      };
      const observed = this.observed(scope, reference, this.issueProjection(issue), issue.revision);
      yield {
        ok: true,
        value: {
          projectId: scope.projectId,
          connectorId: scope.connectorId,
          connectorEpoch: scope.connectorEpoch,
          idempotencyKey: `scan-${issue.repositoryId}-${issue.number}-v${issue.revision}`,
          reference: observed.reference,
          sourceRevision: observed.sourceRevision,
          comparableDigest: observed.comparableDigest,
          observedAt: observed.observedAt,
          freshness: observed.freshness,
          provenance: { kind: "RECONCILIATION" },
          value: observed.value,
        },
      };
    }
  }

  async observeChecks(
    scope: ConnectorScope,
    reference: PublishedGitReference,
  ): Promise<Result<Observed<readonly GitHubCheckObservation[]>>> {
    const fault = this.consumeFault("CHECKS");
    if (fault) return fault;
    const value = this.checks.get(reference.commitSha) ?? [];
    return {
      ok: true,
      value: {
        value,
        reference: `CHECKS:${reference.remoteIdentity}:${reference.commitSha}`,
        sourceRevision: reference.commitSha,
        comparableDigest: sha256(value) as never,
        projectionRevision: 0,
        observedAt: Date.now(),
        freshness: "FRESH",
        provenance: {
          projectId: scope.projectId,
          connectorId: scope.connectorId,
          connectorEpoch: scope.connectorEpoch,
          kind: "RECONCILIATION",
        },
      },
    };
  }

  async listDependencies(
    scope: ConnectorScope,
    reference: GitHubWorkItemReference,
  ): Promise<Result<Observed<readonly SourceDependency[]>>> {
    const value = this.dependencies.get(githubReferenceKey(reference)) ?? [];
    return {
      ok: true,
      value: {
        value,
        reference: `DEPENDENCIES:${githubReferenceKey(reference)}`,
        sourceRevision: sha256(value),
        comparableDigest: sha256(value) as never,
        projectionRevision: 0,
        observedAt: Date.now(),
        freshness: "FRESH",
        provenance: {
          projectId: scope.projectId,
          connectorId: scope.connectorId,
          connectorEpoch: scope.connectorEpoch,
          kind: "RECONCILIATION",
        },
      },
    };
  }
}
