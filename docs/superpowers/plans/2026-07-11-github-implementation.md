# GitHub Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `GHB-001` through `GHB-015` so Collab projects, mutates, and reconciles explicitly selected GitHub resources while GitHub remains authoritative.

**Architecture:** A narrow `GitHubPort` is the only true-external seam. Its production adapter uses GitHub App installation authentication and its strict fixture adapter drives deterministic tests; both consume Foundation credential, epoch, scope, exact-revision, audit, and `ExecutionAuthority` primitives rather than recreating them. Provider-first commands authorize an exact operation, call GitHub, then persist only confirmed bounded projections and provenance.

**Tech Stack:** Bun 1.3.10, TypeScript 7.0.2, Hono 4.12.29, React 19.2.7, Zod 4.4.3, `bun:sqlite`, Bun test, Playwright 1.61.1, GitHub REST/GraphQL APIs.

## Global Constraints

- Use Bun 1.3.10, one root `package.json`, and one `bun.lock`; pin every dependency exactly.
- The Product Spec is canonical; GitHub owns issue, pull-request, Milestone, Project, check, permission, review, merge, and native lifecycle state.
- Pull-request review and merge remain GitHub-native actions that Collab observes; do not add review or merge mutations.
- Import Foundation `ExecutionAuthority`, connector credential encryption, connector epochs, scope policy, exact-revision authorization, audit, reconciliation, and source-reference primitives; do not implement parallel versions.
- Every write carries an idempotency key, authenticated actor, expected revision or prior value, and typed uppercase result code.
- Persist references, bounded projections, freshness, revisions, hashes, provenance, and path-free collision summaries; never persist unselected repository content, raw source diffs, credentials, provider error bodies, or absolute local paths.
- No generic REST URL, GraphQL document, HTTP node, provider payload, command, executable, argument, environment, or shell escape hatch.
- Local fixture evidence cannot mark a live acceptance requirement `PASS`; keep it `IN_PROGRESS` or `BLOCKED` until the disposable GitHub journey is captured.
- Start every executable behavior with an observed failing Bun test, then make the smallest implementation pass.
- Do not mutate production GitHub resources, push, merge, publish, or post public comments without explicit authority.

---

## File Map

- `src/shared/contracts/github.ts`: closed GitHub references, projections, mutations, webhooks, dependencies, checks, and Zod schemas.
- `src/server/db/migrations/0101_github.sql`: installations, selected scopes, delivery deduplication, projections, and reconciliation cursors.
- `src/server/db/migrations/0102_coordination_source_mapping.sql`: canonical source keys, aliases, link conflicts, and mutation provenance.
- `src/server/db/migrations/0103_github_attention.sql`: GitHub attention projections and personal Inbox state.
- `src/server/adapters/github/contract.ts`: narrow `GitHubPort` interface.
- `src/server/adapters/github/{app-auth,client,scope,webhooks,reconciliation}.ts`: production App authentication, scope enforcement, signed ingestion, and refresh.
- `src/server/adapters/github/{issues,pull-requests,milestones,projects,revision-cas}.ts`: explicit provider-first reads and mutations.
- `src/server/modules/github-coordination/{mutations,assignment-delegation,delivery,dependencies}.ts`: GitHub-specific orchestration over Foundation authority.
- `src/server/modules/coordination-records/{canonical-key,source-links,collisions}.ts`: canonical mapping, late links, coalescing, and path-free collisions.
- `src/server/modules/evidence/{diff-evidence,github-checks}.ts`: bounded diff evidence and exact-SHA check observation.
- `src/server/modules/inbox/{github-events,inbox,command-center}.ts`: deduplicated personal attention and non-authoritative lanes.
- `src/server/adapters/http/routes/{connectors-github,github-issues,github-planning,coordination-records}.ts`: thin authenticated HTTP adapters.
- `src/server/adapters/mcp/github-tools.ts`: thin MCP translation to the same commands and queries.
- `src/web/features/github/`, `src/web/features/inbox/`, `src/web/features/command-center/`: GitHub, planning, Inbox, and operational projections.
- `tests/fixtures/github/strict-github-adapter.ts`: stateful strict provider adapter with scope, revision, delivery, and fault controls.
- `docs/evidence/github/EVIDENCE-TEMPLATE.md`, `docs/evidence/github/LIVE-DOGFOOD-LEDGER.md`: exact local and live proof records created during implementation.

### Task 1: GitHub Contracts and Persistence

**Requirements:** Contract and migration prerequisites for `GHB-001` and `GHB-002`.

**Files:**
- Create: `src/shared/contracts/github.ts`
- Create: `src/server/adapters/github/contract.ts`
- Create: `src/server/db/migrations/0101_github.sql`
- Create: `src/server/db/migrations/0101_github.verify.ts`
- Test: `tests/unit/github/contracts.test.ts`
- Test: `tests/integration/github/migration-0101.test.ts`

**Interfaces:**
- Consumes: Foundation `Result<T>`, `Observed<T>`, `ExactRevisionMutation<T>`, `ConnectorScope`, `ReconciliationEvent<T>`, and `SourceConnector<TReference,TProjection,TMutation>` from `src/server/modules/connectors/contract.ts`.
- Produces:

```ts
export interface GitHubPort
  extends SourceConnector<GitHubReference, GitHubProjection, GitHubMutation> {
  observeChecks(reference: PublishedGitReference): Promise<Result<readonly GitHubCheckObservation[]>>;
  listDependencies(reference: GitHubWorkItemReference): Promise<Result<Observed<readonly SourceDependency[]>>>;
}

export type GitHubMutation =
  | { kind: "CREATE_ISSUE"; repository: GitHubRepositoryRef; title: string; body: string }
  | { kind: "EDIT_ISSUE"; issue: GitHubIssueRef; expectedRevision: string; title?: string; body?: string }
  | { kind: "ADD_COMMENT"; issue: GitHubIssueRef; body: string; actionDigest: string }
  | { kind: "SET_LABELS"; issue: GitHubIssueRef; expectedRevision: string; labels: readonly string[] }
  | { kind: "SET_ASSIGNEES"; issue: GitHubIssueRef; expectedRevision: string; logins: readonly string[] }
  | { kind: "SET_MILESTONE"; item: GitHubWorkItemReference; expectedRevision: string; milestoneNumber: number | null }
  | { kind: "SET_ISSUE_STATE"; issue: GitHubIssueRef; expectedRevision: string; state: "OPEN" | "CLOSED"; reason?: "COMPLETED" | "NOT_PLANNED" }
  | { kind: "CREATE_MILESTONE"; repository: GitHubRepositoryRef; title: string; description: string; dueOn: string | null }
  | { kind: "EDIT_MILESTONE"; milestone: GitHubMilestoneRef; expectedRevision: string; title?: string; description?: string; dueOn?: string | null; state?: "OPEN" | "CLOSED" }
  | { kind: "ADD_PROJECT_ITEM"; project: GitHubProjectRef; item: GitHubWorkItemReference }
  | { kind: "REMOVE_PROJECT_ITEM"; project: GitHubProjectRef; itemId: string; expectedRevision: string }
  | { kind: "SET_PROJECT_FIELD"; project: GitHubProjectRef; itemId: string; fieldId: string; expectedRevision: string; value: GitHubProjectFieldValue }
  | { kind: "MOVE_PROJECT_ITEM"; project: GitHubProjectRef; itemId: string; expectedRevision: string; afterItemId: string | null };
```

- [ ] **Step 1: Write the closed-union and schema tests**

```ts
import { expect, test } from "bun:test";
import { GitHubMutationSchema } from "../../../src/shared/contracts/github.ts";

test("rejects provider escape hatches and unsupported destructive actions", () => {
  expect(GitHubMutationSchema.safeParse({ kind: "RAW_GRAPHQL", document: "mutation { x }" }).success).toBe(false);
  expect(GitHubMutationSchema.safeParse({ kind: "DELETE_MILESTONE", milestoneNumber: 7 }).success).toBe(false);
});
```

- [ ] **Step 2: Run the contract test RED**

Run: `bun test tests/unit/github/contracts.test.ts`

Expected: FAIL with `Cannot find module '../../../src/shared/contracts/github.ts'`.

- [ ] **Step 3: Add the exact tables and constraints**

```sql
CREATE TABLE github_installations (
  connector_id TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  connector_epoch INTEGER NOT NULL CHECK (connector_epoch > 0),
  revision INTEGER NOT NULL CHECK (revision > 0)
);
CREATE TABLE github_selected_repositories (
  connector_id TEXT NOT NULL REFERENCES github_installations(connector_id),
  repository_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  permission_digest TEXT NOT NULL,
  PRIMARY KEY (connector_id, repository_id)
);
CREATE TABLE github_selected_projects (
  connector_id TEXT NOT NULL REFERENCES github_installations(connector_id),
  project_node_id TEXT NOT NULL,
  organization_login TEXT NOT NULL,
  PRIMARY KEY (connector_id, project_node_id)
);
CREATE TABLE github_webhook_deliveries (
  connector_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, delivery_id)
);
CREATE TABLE github_source_projections (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('ISSUE','PULL_REQUEST','MILESTONE','PROJECT_ITEM')),
  source_id TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  freshness TEXT NOT NULL CHECK (freshness IN ('FRESH','STALE','UNAVAILABLE','REDACTED')),
  PRIMARY KEY (project_id, connector_id, source_kind, source_id)
);
```

- [ ] **Step 4: Implement the Zod schemas and `GitHubPort` exactly as shown above**

```ts
export const GitHubReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ISSUE"), repositoryId: z.number().int().positive(), number: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("PULL_REQUEST"), repositoryId: z.number().int().positive(), number: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("MILESTONE"), repositoryId: z.number().int().positive(), number: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("PROJECT"), projectNodeId: z.string().min(1) }).strict(),
]);
```

- [ ] **Step 5: Run GREEN and migration verification**

Run: `bun test tests/unit/github/contracts.test.ts tests/integration/github/migration-0101.test.ts && bun run typecheck`

Expected: PASS and exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/shared/contracts/github.ts src/server/adapters/github/contract.ts src/server/db/migrations/0101_github.sql src/server/db/migrations/0101_github.verify.ts tests/unit/github/contracts.test.ts tests/integration/github/migration-0101.test.ts
git commit -m "feat(github): define scoped connector contracts"
```

### Task 2: GitHub App Authentication, Scope Ceiling, and Strict Adapter

**Requirements:** `GHB-001`.

**Files:**
- Create: `src/server/adapters/github/app-auth.ts`
- Create: `src/server/adapters/github/client.ts`
- Create: `src/server/adapters/github/scope.ts`
- Create: `tests/fixtures/github/strict-github-adapter.ts`
- Test: `tests/integration/github/app-scope.test.ts`

**Interfaces:**
- Consumes: Foundation encrypted credential reader, connector epoch, owner-selected repository/project scopes, and current Member authority.
- Produces: `createGitHubClient(input: GitHubClientInput): GitHubPort`, `assertGitHubScope(input: GitHubScopeInput): Result<GitHubAuthorizedScope>`, and `StrictGitHubAdapter implements GitHubPort`.

- [ ] **Step 1: Write the hard-ceiling test**

```ts
test("redacts an organization Project item from an unselected repository", async () => {
  const github = StrictGitHubAdapter.seed({ selectedRepositoryIds: [101], selectedProjectIds: ["PVT_1"] });
  github.addProjectItem("PVT_1", { repositoryId: 202, number: 9, title: "secret" });
  const result = await github.inspect({ kind: "PROJECT", projectNodeId: "PVT_1" });
  expect(result.ok).toBe(true);
  expect(result.ok && result.value.value).toEqual(expect.objectContaining({ unsupportedRepositoryItems: 1 }));
  expect(JSON.stringify(result)).not.toContain("secret");
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/integration/github/app-scope.test.ts`

Expected: FAIL with missing `StrictGitHubAdapter`.

- [ ] **Step 3: Implement App token creation and scope intersection**

```ts
export function assertGitHubScope(input: GitHubScopeInput): Result<GitHubAuthorizedScope> {
  if (input.connectorEpoch !== input.expectedConnectorEpoch) return failure("CONNECTOR_REVOKED", "REFRESH");
  if (!input.selectedRepositoryIds.has(input.repositoryId)) return failure("GITHUB_REPOSITORY_NOT_SELECTED", "NEVER");
  if (input.projectNodeId && !input.selectedProjectIds.has(input.projectNodeId)) return failure("GITHUB_PROJECT_NOT_SELECTED", "NEVER");
  return success({ connectorId: input.connectorId, repositoryId: input.repositoryId, projectNodeId: input.projectNodeId });
}
```

- [ ] **Step 4: Implement the stateful strict adapter**

```ts
export class StrictGitHubAdapter implements GitHubPort {
  readonly calls: GitHubCall[] = [];
  private readonly faults = new Map<GitHubOperationKind, GitHubFixtureFault>();
  static seed(seed: GitHubFixtureSeed): StrictGitHubAdapter { return new StrictGitHubAdapter(seed); }
  failNext(kind: GitHubOperationKind, fault: GitHubFixtureFault): void { this.faults.set(kind, fault); }
  async inspect(reference: GitHubReference): Promise<Result<Observed<GitHubProjection>>> {
    return inspectFixtureReference(this.state, this.calls, reference);
  }
  async mutate(command: ExactRevisionMutation<GitHubMutation>): Promise<Result<Observed<GitHubProjection>>> {
    return mutateFixtureReference(this.state, this.calls, this.faults, command);
  }
  reconcile(scope: ConnectorScope): AsyncIterable<ReconciliationEvent<GitHubProjection>> {
    return reconcileFixtureScope(this.state, this.calls, scope);
  }
  async observeChecks(reference: PublishedGitReference): Promise<Result<readonly GitHubCheckObservation[]>> {
    return observeFixtureChecks(this.state, this.calls, reference);
  }
  async listDependencies(reference: GitHubWorkItemReference): Promise<Result<Observed<readonly SourceDependency[]>>> {
    return listFixtureDependencies(this.state, this.calls, reference);
  }
}
```

- [ ] **Step 5: Run GREEN**

Run: `bun test tests/integration/github/app-scope.test.ts && bun run typecheck && bun run lint`

Expected: PASS and exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/server/adapters/github/app-auth.ts src/server/adapters/github/client.ts src/server/adapters/github/scope.ts tests/fixtures/github/strict-github-adapter.ts tests/integration/github/app-scope.test.ts
git commit -m "feat(github): enforce app scope ceiling"
```

### Task 3: Signed Webhooks and Reconciliation

**Requirements:** `GHB-002`.

**Files:**
- Create: `src/server/adapters/github/webhooks.ts`
- Create: `src/server/adapters/github/reconciliation.ts`
- Create: `src/server/adapters/http/routes/connectors-github.ts`
- Modify: `src/server/app.ts`
- Test: `tests/integration/github/webhook-reconciliation.test.ts`
- Test: `tests/drills/github-missed-webhook.test.ts`

**Interfaces:**
- Consumes: `ExecutionAuthority.execute({ kind: "RECONCILE_SOURCE", ... })`, Foundation audit/idempotency, `GitHubPort.reconcile`, selected scope, and current connector epoch.
- Produces: `verifyGitHubWebhook(request, secret): Result<VerifiedGitHubDelivery>` and `reconcileGitHubScope(scope): Promise<Result<ReconciliationSummary>>`.

- [ ] **Step 1: Write signature, replay, reorder, and missed-delivery tests**

```ts
test("deduplicates a signed delivery and converges after a missed webhook", async () => {
  const first = await harness.ingest(signedDelivery("d-1", "issues", issueOpened));
  const replay = await harness.ingest(signedDelivery("d-1", "issues", issueOpened));
  harness.github.replaceIssue({ ...issueOpened.issue, title: "changed outside Collab" });
  const reconciled = await harness.reconcile();
  expect(first.ok).toBe(true);
  expect(replay).toEqual(first);
  expect(reconciled.updated).toBe(1);
  expect(await harness.projectedTitle()).toBe("changed outside Collab");
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/integration/github/webhook-reconciliation.test.ts tests/drills/github-missed-webhook.test.ts`

Expected: FAIL with missing webhook/reconciliation modules.

- [ ] **Step 3: Implement verification and durable deduplication**

```ts
export async function verifyGitHubWebhook(request: Request, secret: Uint8Array): Promise<Result<VerifiedGitHubDelivery>> {
  const deliveryId = requiredHeader(request, "x-github-delivery");
  const eventName = requiredHeader(request, "x-github-event");
  const body = new Uint8Array(await request.arrayBuffer());
  if (!await verifySha256Signature(body, requiredHeader(request, "x-hub-signature-256"), secret)) {
    return failure("WEBHOOK_SIGNATURE_INVALID", "NEVER");
  }
  return success({ deliveryId, eventName, bodyDigest: sha256(body), body });
}
```

- [ ] **Step 4: Implement bounded reconciliation and mount the route**

```ts
for await (const event of github.reconcile(scope)) {
  await authority.execute({ kind: "RECONCILE_SOURCE", idempotencyKey: `github:${event.deliveryKey}`, event });
}
```

- [ ] **Step 5: Run GREEN**

Run: `bun test tests/integration/github/webhook-reconciliation.test.ts tests/drills/github-missed-webhook.test.ts && bun run typecheck`

Expected: PASS and one projection per source key.

- [ ] **Step 6: Commit**

```bash
git add src/server/adapters/github/webhooks.ts src/server/adapters/github/reconciliation.ts src/server/adapters/http/routes/connectors-github.ts src/server/app.ts tests/integration/github/webhook-reconciliation.test.ts tests/drills/github-missed-webhook.test.ts
git commit -m "feat(github): reconcile signed source events"
```

### Task 4: Provider-First Issues, Milestones, and Projects

**Requirements:** `GHB-003`, `GHB-004`, `GHB-005`.

**Files:**
- Create: `src/server/adapters/github/{issues,pull-requests,milestones,projects,revision-cas}.ts`
- Create: `src/server/modules/github-coordination/mutations.ts`
- Create: `src/server/adapters/http/routes/{github-issues,github-planning}.ts`
- Create: `src/server/adapters/mcp/github-tools.ts`
- Create: `src/web/features/github/{issues,pull-requests,milestones,projects}/index.tsx`
- Test: `tests/integration/github/{issues,milestones,projects,revision-cas}.test.ts`
- Test: `tests/protocol/github-surface-parity.test.ts`
- Test: `tests/e2e/github-planning.spec.ts`

**Interfaces:**
- Consumes: `GitHubPort.mutate`, `ExecutionAuthority.execute({ kind: "AUTHORIZE_OPERATION", operation: { kind: "MUTATE_GITHUB", ... } })`, current epoch/scope, and exact source revision.
- Produces: `performGitHubMutation(command: AuthorizedGitHubMutation): Promise<Result<Observed<GitHubProjection>>>`.

- [ ] **Step 1: Write exhaustive provider-first contract tests**

```ts
test.each([
  "CREATE_ISSUE", "EDIT_ISSUE", "ADD_COMMENT", "SET_LABELS", "SET_ASSIGNEES", "SET_MILESTONE",
  "SET_ISSUE_STATE", "CREATE_MILESTONE", "EDIT_MILESTONE", "ADD_PROJECT_ITEM", "REMOVE_PROJECT_ITEM",
  "SET_PROJECT_FIELD", "MOVE_PROJECT_ITEM",
] as const)("confirms %s before projection", async (kind) => {
  const result = await fixture.execute(validMutation(kind));
  expect(fixture.events()).toEqual([`AUTHORIZED:${kind}`, `PROVIDER_CONFIRMED:${kind}`, `PROJECTED:${kind}`]);
  expect(result.ok).toBe(true);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/integration/github/issues.test.ts tests/integration/github/milestones.test.ts tests/integration/github/projects.test.ts tests/integration/github/revision-cas.test.ts`

Expected: FAIL because `performGitHubMutation` is missing.

- [ ] **Step 3: Implement the authorize-call-confirm sequence**

```ts
export async function performGitHubMutation(command: AuthorizedGitHubMutation): Promise<Result<Observed<GitHubProjection>>> {
  const authorization = await authority.execute(toAuthorizeOperation(command));
  if (!authorization.ok) return authorization;
  const observed = await github.mutate({ mutation: command.mutation, expectedRevision: command.expectedRevision });
  if (!observed.ok) return await recordVisibleProviderFailure(command, observed.error);
  return await authority.execute(toRecordConfirmedProjection(command, observed.value));
}
```

- [ ] **Step 4: Implement stale compare-and-set and residual-race results**

```ts
if (current.revision !== command.expectedRevision) {
  return failure("SOURCE_REVISION_STALE", "REFRESH", { observedRevision: current.revision });
}
const written = await write(command);
return { ...written, consistency: nativeConditionalWrite ? "ATOMIC" : "RESIDUAL_RACE" };
```

- [ ] **Step 5: Add HTTP/MCP parity and planning browser behavior**

```ts
expect(await http.mutate(command)).toEqual(await mcp.mutate(command));
await expect(page.getByRole("column", { name: "In progress" })).toContainText("Issue 42");
```

- [ ] **Step 6: Run GREEN**

Run: `bun test tests/integration/github/{issues,milestones,projects,revision-cas}.test.ts tests/protocol/github-surface-parity.test.ts && bun run test:e2e:run github-planning.spec.ts`

Expected: PASS; stale writes return `SOURCE_REVISION_STALE` and unselected items remain redacted.

- [ ] **Step 7: Commit**

```bash
git add src/server/adapters/github src/server/modules/github-coordination/mutations.ts src/server/adapters/http/routes/github-issues.ts src/server/adapters/http/routes/github-planning.ts src/server/adapters/mcp/github-tools.ts src/web/features/github tests/integration/github tests/protocol/github-surface-parity.test.ts tests/e2e/github-planning.spec.ts
git commit -m "feat(github): add provider-first planning mutations"
```

### Task 5: Canonical Coordination, Assignment, Delegation, and Delivery

**Requirements:** `GHB-006`, `GHB-007`, `GHB-008`.

**Files:**
- Create: `src/server/db/migrations/0102_coordination_source_mapping.sql`
- Create: `src/server/db/migrations/0102_coordination_source_mapping.verify.ts`
- Modify: `src/server/modules/coordination-records/{canonical-key,source-links}.ts`
- Create: `src/server/modules/github-coordination/{assignment-delegation,delivery}.ts`
- Create: `src/server/adapters/http/routes/coordination-records.ts`
- Test: `tests/integration/coordination-records/{canonical-link,coalescing}.test.ts`
- Test: `tests/integration/github/{assignment-delegation,delivery}.test.ts`

**Interfaces:**
- Consumes: Foundation source-free Coordination Records, `ExecutionAuthority.execute` commands `LINK_SOURCE_REFERENCE`, `LAUNCH_RUN`, and bounded evidence recording.
- Produces: canonical key `(project_id, connector_id, source_item_id)`, immutable aliases, independent `AssignmentDelegationResult`, and closing-reference derivation.

- [ ] **Step 1: Write concurrent late-link and partial-success tests**

```ts
test("late-link race selects one record without rewriting completed run provenance", async () => {
  const [a, b] = await Promise.all([fixture.link(recordA, issue42), fixture.link(recordB, issue42)]);
  expect([a, b].filter((result) => result.ok)).toHaveLength(1);
  expect(await fixture.canonical(issue42)).toBe(a.ok ? recordA : recordB);
  expect(await fixture.completedRunRecord(completedRun)).toBe(recordB);
  expect(await fixture.aliasFor(recordB)).toBe(await fixture.canonical(issue42));
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/integration/coordination-records/canonical-link.test.ts tests/integration/coordination-records/coalescing.test.ts tests/integration/github/assignment-delegation.test.ts`

Expected: FAIL with missing canonical mapping migration.

- [ ] **Step 3: Add canonical and provenance tables**

```sql
CREATE TABLE coordination_source_keys (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  coordination_record_id TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  linked_by_member_id TEXT NOT NULL,
  PRIMARY KEY (project_id, connector_id, source_item_id)
);
CREATE TABLE coordination_record_aliases (
  alias_record_id TEXT PRIMARY KEY,
  canonical_record_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('AUTHORIZED_COALESCE')),
  created_at TEXT NOT NULL
);
```

- [ ] **Step 4: Implement independent assignment and delegation**

```ts
export type AssignmentDelegationResult = Readonly<{
  assignment: Result<Observed<GitHubProjection>>;
  delegation: Result<LaunchRunResult>;
}>;
export async function assignAndDelegate(command: AssignAndDelegate): Promise<AssignmentDelegationResult> {
  const [assignment, delegation] = await Promise.allSettled([assign(command.assignment), delegate(command.delegation)]);
  return { assignment: settledResult(assignment), delegation: settledResult(delegation) };
}
```

- [ ] **Step 5: Implement delivery observation without source fabrication**

```ts
export function closingReference(issue: GitHubIssueRef): string {
  return `Closes ${issue.owner}/${issue.repository}#${issue.number}`;
}
// PR merge updates only the PR projection; issue closure changes only after GitHub reports CLOSED.
```

- [ ] **Step 6: Run GREEN**

Run: `bun test tests/integration/coordination-records tests/integration/github/assignment-delegation.test.ts tests/integration/github/delivery.test.ts`

Expected: PASS; partial successes remain independently retryable and merged/open remains visible.

- [ ] **Step 7: Commit**

```bash
git add src/server/db/migrations/0102_coordination_source_mapping.sql src/server/db/migrations/0102_coordination_source_mapping.verify.ts src/server/modules/coordination-records src/server/modules/github-coordination/assignment-delegation.ts src/server/modules/github-coordination/delivery.ts src/server/adapters/http/routes/coordination-records.ts tests/integration/coordination-records tests/integration/github/assignment-delegation.test.ts tests/integration/github/delivery.test.ts
git commit -m "feat(github): link canonical coordination delivery"
```

### Task 6: Mutation Guards, Collisions, Diff Evidence, Checks, and Dependencies

**Requirements:** `GHB-009`, `GHB-010`, `GHB-011`, `GHB-012`.

**Files:**
- Modify: `src/server/modules/coordination-records/mutation-guard.ts`
- Create: `src/server/modules/coordination-records/collisions.ts`
- Create: `src/server/modules/evidence/{diff-evidence,github-checks}.ts`
- Create: `src/server/modules/github-coordination/dependencies.ts`
- Create: `src/runner/repository/changed-paths.ts`
- Test: `tests/integration/coordination-records/{mutation-guard,collisions}.test.ts`
- Test: `tests/integration/evidence/diff-evidence.test.ts`
- Test: `tests/integration/github/{checks,dependencies}.test.ts`

**Interfaces:**
- Consumes: Foundation mutation reservation/lease, evidence command, normalized repository-relative path schemas, and `GitHubPort.observeChecks/listDependencies`.
- Produces: `ChangedPathSnapshot`, `CollisionAuditRecord`, `DiffEvidence`, `GitHubCheckEvidence`, and advisory `SourceDependencyView`.

- [ ] **Step 1: Write guard/collision/evidence/check/dependency tests**

```ts
test("keeps independent overlap advisory and exact branch collision blocking", async () => {
  expect((await fixture.launch(runA, { branch: "collab/a" })).ok).toBe(true);
  const blocked = await fixture.launch(runB, { branch: "collab/a" });
  expect(blocked.ok).toBe(false);
  if (blocked.ok) throw new Error("expected branch collision");
  expect(blocked.error.code).toBe("BRANCH_COLLISION");
  await fixture.paths(runA, ["src/a.ts"]); await fixture.paths(runC, ["src/a.ts"]);
  expect(await fixture.collision(runA, runC)).toEqual(expect.objectContaining({ blocking: false, overlapCount: 1 }));
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/integration/coordination-records/{mutation-guard,collisions}.test.ts tests/integration/evidence/diff-evidence.test.ts tests/integration/github/{checks,dependencies}.test.ts`

Expected: FAIL with missing collision/evidence modules.

- [ ] **Step 3: Implement bounded path and evidence schemas**

```ts
export const RepositoryPathSchema = z.string().max(512).refine((value) =>
  !value.startsWith("/") && !value.split("/").includes("..") && !/[\u0000-\u001f]/u.test(value),
  "repository-relative canonical path required",
);
export const ChangedPathSnapshotSchema = z.object({
  runId: AgentRunIdSchema, baseSha: CommitShaSchema, paths: z.array(RepositoryPathSchema).max(4096), truncated: z.boolean(), observedAt: z.string(),
}).strict();
```

- [ ] **Step 4: Implement exact-SHA checks and non-authoritative dependencies**

```ts
export function evaluateCheck(observation: GitHubCheckObservation, published: PublishedGitReference): Result<GitHubCheckEvidence> {
  if (observation.commitSha !== published.commitSha) return failure("GATE_EVALUATION_STALE", "REFRESH");
  return success({ checkRunId: observation.checkRunId, commitSha: observation.commitSha, conclusion: observation.conclusion });
}
export const dependencyWarning = (value: Observed<readonly SourceDependency[]>): SourceDependencyView => ({
  freshness: value.freshness, dependencies: value.value, blocksLaunch: false, changesRunState: false,
});
```

- [ ] **Step 5: Run GREEN and the malicious-path drill**

Run: `bun test tests/integration/coordination-records/{mutation-guard,collisions}.test.ts tests/integration/evidence/diff-evidence.test.ts tests/integration/github/{checks,dependencies}.test.ts`

Expected: PASS; raw diff fields and traversal/control/oversized paths are rejected.

- [ ] **Step 6: Commit**

```bash
git add src/server/modules/coordination-records src/server/modules/evidence src/server/modules/github-coordination/dependencies.ts src/runner/repository/changed-paths.ts tests/integration/coordination-records tests/integration/evidence tests/integration/github/checks.test.ts tests/integration/github/dependencies.test.ts
git commit -m "feat(github): add bounded collision and check evidence"
```

### Task 7: Revocation, Inbox, and Command Center

**Requirements:** `GHB-013`, `GHB-014`.

**Files:**
- Create: `src/server/db/migrations/0103_github_attention.sql`
- Create: `src/server/db/migrations/0103_github_attention.verify.ts`
- Create: `src/server/modules/inbox/{github-events,inbox,command-center}.ts`
- Create: `src/web/features/inbox/index.tsx`
- Create: `src/web/features/command-center/index.tsx`
- Modify: `src/web/app.tsx`
- Test: `tests/drills/{github-scope-narrowing,github-member-offboarding}.test.ts`
- Test: `tests/integration/inbox/github-attention.test.ts`
- Test: `tests/e2e/github-attention.spec.ts`

**Interfaces:**
- Consumes: Foundation `APPLY_REVOCATION`, connector epoch, Member authority epoch, committed audit/events, and read-only projections.
- Produces: deduplicated `InboxItem` categories `ACTION_REQUIRED|BLOCKED|WARNING|OUTCOME` and lanes `NEEDS_ATTENTION|ACTIVE_NOW|WAITING_AND_SCHEDULED|RECENTLY_FINISHED`.

- [ ] **Step 1: Write revocation and projection tests**

```ts
test("scope narrowing denies new operations and deduplicates attention", async () => {
  await fixture.narrowScope({ repositoryIds: [] });
  const denied = await fixture.comment(issue42);
  expect(denied.ok).toBe(false);
  if (denied.ok) throw new Error("expected connector revocation");
  expect(denied.error.code).toBe("CONNECTOR_REVOKED");
  await fixture.emitConnectorWarning(issue42); await fixture.emitConnectorWarning(issue42);
  expect(await fixture.inboxItems({ subject: issue42 })).toHaveLength(1);
  expect(await fixture.commandCenterCard(issue42)).toEqual(expect.objectContaining({ lane: "NEEDS_ATTENTION", draggable: false }));
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/drills/github-scope-narrowing.test.ts tests/drills/github-member-offboarding.test.ts tests/integration/inbox/github-attention.test.ts`

Expected: FAIL with missing Inbox schema/module.

- [ ] **Step 3: Add attention persistence and derivation**

```sql
CREATE TABLE inbox_items (
  recipient_member_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('ACTION_REQUIRED','BLOCKED','WARNING','OUTCOME')),
  safe_summary TEXT NOT NULL,
  unread INTEGER NOT NULL CHECK (unread IN (0,1)),
  resolved_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (recipient_member_id, event_type, subject_key)
);
```

- [ ] **Step 4: Implement epoch-first revocation and non-authoritative UI actions**

```ts
await authority.execute({ kind: "APPLY_REVOCATION", source: { kind: "CONNECTOR", connectorId, connectorEpoch: nextEpoch } });
// Command Center card actions call typed commands; lane movement has no write handler.
```

- [ ] **Step 5: Run GREEN and browser verification**

Run: `bun test tests/drills/github-scope-narrowing.test.ts tests/drills/github-member-offboarding.test.ts tests/integration/inbox/github-attention.test.ts && bun run test:e2e:run github-attention.spec.ts`

Expected: PASS; removed authority fails immediately and cards expose no drag lifecycle mutation.

- [ ] **Step 6: Commit**

```bash
git add src/server/db/migrations/0103_github_attention.sql src/server/db/migrations/0103_github_attention.verify.ts src/server/modules/inbox src/web/features/inbox src/web/features/command-center src/web/app.tsx tests/drills/github-scope-narrowing.test.ts tests/drills/github-member-offboarding.test.ts tests/integration/inbox/github-attention.test.ts tests/e2e/github-attention.spec.ts
git commit -m "feat(github): project revocation and team attention"
```

### Task 8: Strict Fixture Journey, Live Ledger, and Phase Gate

**Requirements:** `GHB-015` and final evidence for `GHB-001` through `GHB-014`.

**Files:**
- Create: `tests/e2e/github-delivery.spec.ts`
- Create: `tests/drills/github-storage-canary.test.ts`
- Create: `docs/evidence/github/EVIDENCE-TEMPLATE.md`
- Create: `docs/evidence/github/LIVE-DOGFOOD-LEDGER.md`
- Modify: `MANIFEST.md`
- Modify: `MANIFEST.sha256`

**Interfaces:**
- Consumes: all GitHub contracts, strict adapter fault controls, authenticated disposable live installation configuration, and acceptance evidence schema.
- Produces: one fixture-backed end-to-end journey and one append-only live ledger whose rows contain build, repository revision, provider URL/revision, Collab IDs, audit IDs, commands, result, reviewer, and blocker.

- [ ] **Step 1: Write the complete fixture-backed journey**

```ts
test("triages through observed GitHub closure without fabricated state", async ({ page }) => {
  await seedGitHubIssue({ state: "OPEN", missedWebhook: true });
  await assignAndDelegate(page); await publishClosingReference(page);
  await mergeInFixtureGitHub();
  await expect(issueState(page)).resolves.toBe("OPEN");
  await fixtureGitHub.reportIssueClosed(); await runReconciliation();
  await expect(issueState(page)).resolves.toBe("CLOSED");
});
```

- [ ] **Step 2: Run RED**

Run: `bun run test:e2e:run github-delivery.spec.ts`

Expected: FAIL until the full journey and composition wiring exist.

- [ ] **Step 3: Add an executable storage-canary drill**

```ts
const canary = `github-body-${crypto.randomUUID()}`;
await fixture.createIssue({ title: "Canary", body: canary });
await exerciseSearchMutationReconciliationBackup();
for (const store of await prohibitedStores()) expect(store.bytes.includes(canary)).toBe(false);
```

- [ ] **Step 4: Create exact evidence templates**

```markdown
| Requirement | Build | Git revision | GitHub resource/revision | Collab record/run/audit IDs | Journey/command | Result | Reviewer | Blocker |
|---|---|---|---|---|---|---|---|---|
```

- [ ] **Step 5: Run the local GitHub gate GREEN**

Run: `bun test tests/unit/github tests/integration/github tests/integration/coordination-records tests/integration/evidence tests/integration/inbox tests/protocol/github-surface-parity.test.ts tests/drills/github-*.test.ts && bun run test:e2e:run github-planning.spec.ts github-attention.spec.ts github-delivery.spec.ts`

Expected: PASS and exit 0; live-only ledger rows remain `IN_PROGRESS` or `BLOCKED` until executed.

- [ ] **Step 6: Execute authorized disposable live evidence**

Run: `COLLAB_LIVE_GITHUB=1 bun run test:e2e:run github-delivery.spec.ts`

Expected: PASS only with an explicitly approved disposable installation; otherwise SKIP with `LIVE_GITHUB_NOT_AUTHORIZED`, recorded as `BLOCKED`, never `PASS`.

- [ ] **Step 7: Run the full package gate**

Run: `bun ci && bun run format:check && bun run lint && bun run typecheck && bun run test && bun run build && bunx playwright install chromium && bun run test:e2e:run && bun run audit:public && bun run manifest:verify && SESSION_SECRET=0123456789abcdef0123456789abcdef PUBLIC_BASE_URL=https://collab.test WEBAUTHN_RP_ID=collab.test DEPLOYMENT_MASTER_KEY_FILE=.env.example BOOTSTRAP_SECRET_FILE=.env.example BACKUP_DIR=/backups docker compose config --quiet && docker build --tag 2collab:verify . && git diff --check`

Expected: every command exits 0.

- [ ] **Step 8: Commit**

```bash
git add tests/e2e/github-delivery.spec.ts tests/drills/github-storage-canary.test.ts docs/evidence/github/EVIDENCE-TEMPLATE.md docs/evidence/github/LIVE-DOGFOOD-LEDGER.md MANIFEST.md MANIFEST.sha256
git commit -m "test(github): record authoritative delivery evidence"
```
