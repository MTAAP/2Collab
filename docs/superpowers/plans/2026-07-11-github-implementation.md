# GitHub Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `GHB-001` through `GHB-015` so Collab projects, mutates, and reconciles explicitly selected GitHub resources while GitHub remains authoritative.

**Architecture:** A narrow `GitHubPort` is the only true-external seam. Its production adapter uses GitHub App installation authentication and its strict fixture adapter drives deterministic tests; both consume Foundation credential, epoch, scope, exact-revision, audit, and `ExecutionAuthority` primitives rather than recreating them. Provider-first commands authorize an exact operation, call GitHub, then persist only confirmed bounded projections and provenance.

**Tech Stack:** Bun 1.3.10, TypeScript 7.0.2, Hono 4.12.29, React 19.2.7, Zod 4.4.3, `bun:sqlite`, Bun test, Playwright 1.61.1, GitHub REST/GraphQL APIs.

**Migration reconciliation:** Foundation corrective migration `0006_foundation_configuration_corrections` is immutable history. GitHub migrations therefore occupy `0007-0009`; Outline and Automation continue from `0010`.

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
- `src/server/db/migrations/0007_github.sql`: installations, selected scopes, delivery deduplication, projections, and reconciliation cursors.
- `src/server/db/migrations/0008_coordination_source_mapping.sql`: canonical source keys, aliases, link conflicts, and mutation provenance.
- `src/server/db/migrations/0009_github_attention.sql`: GitHub attention projections and personal Inbox state.
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
- Create: `src/server/db/migrations/0007_github.sql`
- Create: `src/server/db/migrations/0007_github.verify.ts`
- Modify: `src/server/db/migrate.ts`
- Modify: `src/server/operations/{backup,restore}.ts`
- Test: `tests/unit/github/contracts.test.ts`
- Test: `tests/integration/github/migration-0007.test.ts`
- Test: `tests/integration/github/projection-storage-safety.test.ts`
- Test: `tests/drills/backup-restore.test.ts`

**Interfaces:**
- Consumes: Foundation `Result<T>`, `Observed<T>`, `ExactRevisionMutation<T>`, `ConnectorScope`, `ReconciliationEvent<T>`, and `SourceConnector<TReference,TProjection,TMutation>` from `src/server/modules/connectors/contract.ts`.
- Produces:

```ts
export interface GitHubPort
  extends SourceConnector<GitHubReference, GitHubProjection, GitHubMutation> {
  observeChecks(scope: ConnectorScope, reference: PublishedGitReference): Promise<Result<Observed<readonly GitHubCheckObservation[]>>>;
  listDependencies(scope: ConnectorScope, reference: GitHubWorkItemReference): Promise<Result<Observed<readonly SourceDependency[]>>>;
}

export type GitHubMutation =
  | { kind: "CREATE_ISSUE"; repository: GitHubRepositoryRef; title: string; body: string }
  | { kind: "EDIT_ISSUE"; issue: GitHubIssueRef; title?: string; body?: string }
  | { kind: "ADD_COMMENT"; issue: GitHubIssueRef; body: string }
  | { kind: "SET_LABELS"; issue: GitHubIssueRef; labels: readonly string[] }
  | { kind: "SET_ASSIGNEES"; issue: GitHubIssueRef; logins: readonly string[] }
  | { kind: "SET_MILESTONE"; item: GitHubWorkItemReference; milestoneNumber: number | null }
  | { kind: "SET_ISSUE_STATE"; issue: GitHubIssueRef; state: "OPEN" | "CLOSED"; reason: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED" }
  | { kind: "CREATE_MILESTONE"; repository: GitHubRepositoryRef; title: string; description: string; dueOn: string | null }
  | { kind: "EDIT_MILESTONE"; milestone: GitHubMilestoneRef; title?: string; description?: string; dueOn?: string | null; state?: "OPEN" | "CLOSED" }
  | { kind: "ADD_PROJECT_ITEM"; project: GitHubProjectRef; item: GitHubWorkItemReference }
  | { kind: "REMOVE_PROJECT_ITEM"; project: GitHubProjectRef; itemId: string }
  | { kind: "SET_PROJECT_FIELD"; project: GitHubProjectRef; itemId: string; fieldId: string; value: GitHubProjectFieldValue }
  | { kind: "MOVE_PROJECT_ITEM"; project: GitHubProjectRef; itemId: string; afterItemId: string | null };
```

`GitHubPort` is immutably bound to an exact authorized project/connector scope and current connector
epoch, or receives that scope explicitly on every call. It returns normalized `Observed<T>` values
only. It never owns member authorization, connector epochs, idempotency/audit persistence,
Coordination Record mapping, or projection persistence. Human writes enter Foundation
`ConnectorAuthority`; attempt writes first consume an `ExecutionAuthority` operation authorization and
then use the same connector path.

GitHub does not provide a universal atomic compare-and-set for these unsafe writes. Mutation
orchestration performs final read, exact reviewed-field/revision/digest comparison, provider write,
then read/normalize confirmation, records the residual provider race, and reconciles. Create/additive
operations carry expected absence/membership and a deterministic non-secret action marker/provider ID
so a provider success followed by lost response/local rollback can recover without body-text matching.

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
  connector_id TEXT PRIMARY KEY REFERENCES connector_epochs(connector_id),
  app_id TEXT NOT NULL CHECK(length(app_id) BETWEEN 1 AND 32),
  installation_id TEXT NOT NULL CHECK(installation_id NOT GLOB '*[^0-9]*' AND length(installation_id) BETWEEN 1 AND 32),
  account_id TEXT NOT NULL CHECK(account_id NOT GLOB '*[^0-9]*' AND length(account_id) BETWEEN 1 AND 32),
  account_node_id TEXT NOT NULL CHECK(length(account_node_id) BETWEEN 1 AND 128),
  account_login TEXT NOT NULL CHECK(length(account_login) BETWEEN 1 AND 128),
  private_key_credential_id TEXT NOT NULL REFERENCES encrypted_credentials(id),
  webhook_secret_credential_id TEXT NOT NULL REFERENCES encrypted_credentials(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  UNIQUE(app_id, installation_id)
) STRICT;
CREATE TABLE github_project_connectors (
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES github_installations(connector_id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(project_id, connector_id)
) STRICT;
CREATE TABLE github_selected_repositories (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  repository_id TEXT NOT NULL CHECK(repository_id NOT GLOB '*[^0-9]*' AND length(repository_id) BETWEEN 1 AND 32),
  repository_node_id TEXT NOT NULL CHECK(length(repository_node_id) BETWEEN 1 AND 128),
  owner_login TEXT NOT NULL CHECK(length(owner_login) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
  permission_digest TEXT NOT NULL CHECK(length(permission_digest) = 64),
  scope_state TEXT NOT NULL CHECK(scope_state IN ('SELECTED','REDACTED','REMOVED')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  PRIMARY KEY (project_id, connector_id, repository_id),
  FOREIGN KEY(project_id, connector_id) REFERENCES github_project_connectors(project_id, connector_id)
) STRICT;
CREATE TABLE github_selected_projects (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  github_project_node_id TEXT NOT NULL CHECK(length(github_project_node_id) BETWEEN 1 AND 128),
  organization_id TEXT NOT NULL CHECK(length(organization_id) BETWEEN 1 AND 128),
  organization_login TEXT NOT NULL CHECK(length(organization_login) BETWEEN 1 AND 128),
  scope_state TEXT NOT NULL CHECK(scope_state IN ('SELECTED','REDACTED','REMOVED')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  PRIMARY KEY (project_id, connector_id, github_project_node_id),
  FOREIGN KEY(project_id, connector_id) REFERENCES github_project_connectors(project_id, connector_id)
) STRICT;
CREATE TABLE github_webhook_deliveries (
  connector_id TEXT NOT NULL REFERENCES github_installations(connector_id),
  hook_id TEXT NOT NULL CHECK(length(hook_id) BETWEEN 1 AND 64),
  delivery_id TEXT NOT NULL CHECK(length(delivery_id) BETWEEN 1 AND 128),
  event_name TEXT NOT NULL CHECK(length(event_name) BETWEEN 1 AND 64),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^a-f0-9]*'),
  ingress_state TEXT NOT NULL CHECK(ingress_state IN ('VERIFIED','CONFLICT','REJECTED')),
  received_at INTEGER NOT NULL CHECK(received_at >= 0),
  applied_at INTEGER CHECK(applied_at >= received_at),
  PRIMARY KEY (connector_id, hook_id, delivery_id)
) STRICT;
CREATE TABLE github_webhook_applications (
  connector_id TEXT NOT NULL,
  hook_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('PENDING','APPLIED','REJECTED_SCOPE','CONFLICT','FAILED_RETRYABLE','FAILED_PERMANENT')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(connector_id, hook_id, delivery_id, project_id),
  FOREIGN KEY(connector_id, hook_id, delivery_id) REFERENCES github_webhook_deliveries(connector_id, hook_id, delivery_id),
  FOREIGN KEY(project_id, connector_id) REFERENCES github_project_connectors(project_id, connector_id)
) STRICT;
CREATE TABLE github_source_projections (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  repository_id TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('REPOSITORY','ISSUE','PULL_REQUEST','MILESTONE','PROJECT','PROJECT_FIELD','PROJECT_ITEM')),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 256),
  projection_schema_version INTEGER NOT NULL CHECK(projection_schema_version > 0),
  projection_json TEXT NOT NULL CHECK(length(projection_json) <= 65536 AND json_valid(projection_json)),
  projection_hash TEXT NOT NULL CHECK(length(projection_hash) = 64 AND projection_hash NOT GLOB '*[^a-f0-9]*'),
  source_revision TEXT NOT NULL CHECK(length(source_revision) BETWEEN 1 AND 256),
  comparable_digest TEXT NOT NULL CHECK(length(comparable_digest) = 64 AND comparable_digest NOT GLOB '*[^a-f0-9]*'),
  source_updated_at INTEGER CHECK(source_updated_at >= 0),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  provenance_kind TEXT NOT NULL CHECK(provenance_kind IN ('WEBHOOK','RECONCILIATION','MUTATION_CONFIRMATION')),
  freshness TEXT NOT NULL CHECK (freshness IN ('FRESH','STALE','UNAVAILABLE','REDACTED')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  CHECK(freshness <> 'REDACTED' OR projection_json = '{}'),
  CHECK(source_kind NOT IN ('REPOSITORY','ISSUE','PULL_REQUEST','MILESTONE') OR repository_id IS NOT NULL),
  PRIMARY KEY (project_id, connector_id, source_kind, source_id),
  FOREIGN KEY(project_id, connector_id) REFERENCES github_project_connectors(project_id, connector_id),
  FOREIGN KEY(project_id, connector_id, repository_id) REFERENCES github_selected_repositories(project_id, connector_id, repository_id)
) STRICT;
CREATE TABLE github_reconciliation_cursors (
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES github_installations(connector_id),
  resource_family TEXT NOT NULL CHECK(resource_family IN ('REPOSITORIES','ISSUES','PULL_REQUESTS','MILESTONES','PROJECTS','PROJECT_ITEMS')),
  scope_digest TEXT NOT NULL CHECK(length(scope_digest) = 64 AND scope_digest NOT GLOB '*[^a-f0-9]*'),
  connector_epoch INTEGER NOT NULL CHECK(connector_epoch > 0),
  cursor TEXT CHECK(cursor IS NULL OR length(cursor) <= 1024),
  watermark TEXT CHECK(watermark IS NULL OR length(watermark) <= 256),
  status TEXT NOT NULL CHECK(status IN ('IDLE','SCANNING','RATE_LIMITED','FAILED_RETRYABLE')),
  last_complete_at INTEGER CHECK(last_complete_at >= 0),
  not_before INTEGER CHECK(not_before >= 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY (project_id, connector_id, resource_family)
) STRICT;
```

This is the next contiguous server schema version after Foundation `0005` and is wired into
`migrate.ts`. Verification covers empty-to-v7 and v6-to-v7 upgrades, rollback, history/integrity,
foreign keys, bounds, scope isolation, and claimed-schema checks. Provider integer IDs are bounded
decimal strings, never JavaScript numbers. Mutable logins/names are metadata; immutable IDs/node IDs
are identity. Installation access tokens are never persisted. The App private key and webhook secret
are separate encrypted credential rows, while connector epoch remains authoritative only in
`connector_epochs`.

Selections are per Collab Project, revisioned, and tombstoned/redacted on narrowing. Closed serializers
produce bounded projection JSON with no issue/PR/comment body or raw provider payload. A `REDACTED` row
retains only safe identity/count/provenance. Cursor scans commit absence only after every page succeeds
under one epoch and scope digest. Delivery identity binds connector, hook, delivery ID, and digest:
same ID/same digest replays; changed digest is a security conflict.

- [ ] **Step 4: Implement the Zod schemas and `GitHubPort` exactly as shown above**

```ts
export const GitHubReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ISSUE"), repositoryId: GitHubDecimalIdSchema, number: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("PULL_REQUEST"), repositoryId: GitHubDecimalIdSchema, number: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("MILESTONE"), repositoryId: GitHubDecimalIdSchema, number: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("PROJECT"), projectNodeId: GitHubNodeIdSchema }).strict(),
]);
```

Every reference has an opaque branded identity and explicit collision-free conversion to/from the
Foundation `SourceRef`; repository rename does not change identity. Only Issue and Pull Request
references become actionable Coordination Record source keys. Milestones and Projects remain planning
references. All nested mutation schemas are strict/bounded, reject no-ops and illegal state/reason
combinations (`OPEN` requires `REOPENED`; `CLOSED` requires `COMPLETED`, `NOT_PLANNED`, or
`DUPLICATE`), and expose no raw REST/GraphQL escape hatch. The outer exact-revision envelope, not each
nested variant, owns connector/project/epoch, idempotency, expected revision/prior digest, and action
digest.

- [ ] **Step 5: Run GREEN and migration verification**

Run: `bun test tests/unit/github/contracts.test.ts tests/integration/github/migration-0007.test.ts && bun run typecheck`

Also run: `bun test src/server/db/migrations/0007_github.verify.ts tests/integration/github/projection-storage-safety.test.ts tests/drills/backup-restore.test.ts`.

Expected: PASS and exit 0; schema-6 authenticated backups restore through isolated staging to schema
7, while future/gapped/digest-mismatched backups fail before promotion.

- [ ] **Step 6: Commit**

```bash
git add src/shared/contracts/github.ts src/server/adapters/github/contract.ts src/server/db/migrations/0007_github.sql src/server/db/migrations/0007_github.verify.ts src/server/db/migrate.ts src/server/operations/backup.ts src/server/operations/restore.ts tests/unit/github/contracts.test.ts tests/integration/github/migration-0007.test.ts tests/integration/github/projection-storage-safety.test.ts tests/drills/backup-restore.test.ts
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
  const github = StrictGitHubAdapter.seed({ selectedRepositoryIds: ["101"], selectedProjectIds: ["PVT_1"] });
  github.addProjectItem("PVT_1", { repositoryId: "202", number: 9, title: "secret" });
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

App private keys and webhook secrets are decrypted only through the Foundation credential store and
never enter logs/errors. Generate short-lived installation tokens in memory, request minimum provider
permissions and selected repository IDs, cache only by connector epoch plus exact scope/permission
digest, and discard on expiry, epoch change, suspension, revocation, or permission change. Never
persist an installation token. Enforce the intersection of provider installation repositories,
provider permissions, owner-selected Collab repositories, selected Projects, and current connector
epoch on every call; organization discovery never grants ingestion.

Scope reduction commits the Foundation connector-epoch advance before invalidating queued writes,
clearing token caches/cursors, and redacting affected projections. Tests cover suspension, local/provider
scope disagreement, permission narrowing, an organization Project item from an unselected repository,
and narrowing during an in-flight call. The strict adapter enforces identical scope and epoch rules and
can deterministically simulate paging, rate limits, lost responses, 403/404 distinctions, and external
state changes.

- [ ] **Step 4: Implement the stateful strict adapter**

```ts
export class StrictGitHubAdapter implements GitHubPort {
  readonly calls: GitHubCall[] = [];
  private readonly faults = new Map<GitHubOperationKind, GitHubFixtureFault>();
  static seed(seed: GitHubFixtureSeed): StrictGitHubAdapter { return new StrictGitHubAdapter(seed); }
  failNext(kind: GitHubOperationKind, fault: GitHubFixtureFault): void { this.faults.set(kind, fault); }
  async inspect(scope: ConnectorScope, reference: GitHubReference): Promise<Result<Observed<GitHubProjection>>> {
    return inspectFixtureReference(this.state, this.calls, scope, reference);
  }
  async mutate(authorization: ConnectorOperationAuthorization, command: ExactRevisionMutation<GitHubMutation>): Promise<Result<Observed<GitHubProjection>>> {
    return mutateFixtureReference(this.state, this.calls, this.faults, authorization, command);
  }
  scan(scope: ConnectorScope, cursor?: ReconciliationCursor): AsyncIterable<Result<ReconciliationEvent<GitHubProjection>>> {
    return reconcileFixtureScope(this.state, this.calls, scope, cursor);
  }
  async observeChecks(scope: ConnectorScope, reference: PublishedGitReference): Promise<Result<Observed<readonly GitHubCheckObservation[]>>> {
    return observeFixtureChecks(this.state, this.calls, scope, reference);
  }
  async listDependencies(scope: ConnectorScope, reference: GitHubWorkItemReference): Promise<Result<Observed<readonly SourceDependency[]>>> {
    return listFixtureDependencies(this.state, this.calls, scope, reference);
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
- Create: `src/server/modules/github-coordination/reconciliation-scheduler.ts`
- Create: `src/server/adapters/http/routes/connectors-github.ts`
- Modify: `src/server/app.ts`
- Test: `tests/integration/github/webhook-reconciliation.test.ts`
- Test: `tests/integration/github/reconciliation-scheduler.test.ts`
- Test: `tests/drills/github-missed-webhook.test.ts`

**Interfaces:**
- Consumes: Foundation `ConnectorAuthority.reconcileSource`, audit/idempotency,
  `GitHubPort.reconcile`, selected scope, and current connector epoch.
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
export async function consumeVerifiedGitHubWebhook(request: Request, secret: Uint8Array, limits: WebhookLimits, consume: (delivery: EphemeralVerifiedGitHubDelivery) => Promise<Result<WebhookReceipt>>): Promise<Result<WebhookReceipt>> {
  requireSupportedJsonEncoding(request);
  rejectOversizedContentLength(request, limits.maxBodyBytes);
  const hookId = requiredHeader(request, "x-github-hook-id");
  const deliveryId = requiredHeader(request, "x-github-delivery");
  const eventName = requiredHeader(request, "x-github-event");
  const body = await readBodyStreamBounded(request.body, limits.maxBodyBytes);
  if (!await verifySha256Signature(body, requiredHeader(request, "x-hub-signature-256"), secret)) {
    return failure("WEBHOOK_SIGNATURE_INVALID", "NEVER");
  }
  return consume(internalVerifiedDelivery({ hookId, deliveryId, eventName, bodyDigest: sha256(body), body }));
}
```

- [ ] **Step 4: Implement bounded reconciliation and mount the route**

```ts
for await (const scanned of github.scan(scope, cursor)) {
  if (!scanned.ok) return scanned;
  await connectorAuthority.reconcileSource({ idempotencyKey: `github:${scanned.value.deliveryKey}`, scope, event: scanned.value });
}
```

Verify `X-Hub-Signature-256` over the exact bounded raw bytes with constant-time comparison before
parsing, logging, deduplication, or scope decisions. The verified wrapper exposes only a short-lived
body handle to the closed event parser; raw webhook bytes are never durable. Bind delivery dedup to
connector, hook/App identity, delivery ID, and body digest. Same ID/digest replays; same ID with a
different digest is a security conflict. Valid but unselected events emit only a categorical safe
audit fact and no title/body/label/actor projection.

Webhook, periodic reconciliation, and mutation confirmation converge through the same Foundation
projection-application path. Older observations never regress newer projections; same source revision
with a different normalized hash forces a point refresh. A paginated scan may tombstone absence only
after every page succeeds under one connector epoch and scope digest. Rate limit, transient failure, or
scope narrowing leaves prior projections intact and a resumable cursor; `MISSING`, `FORBIDDEN`,
`UNAVAILABLE`, and `REDACTED` remain distinct.

The verified delivery wrapper is internal, non-serializable, and consumed immediately by a closed
bounded parser; generally loggable `Result` values never contain body bytes. Require supported JSON
content type/encoding, bounded identifiers, exact App/installation/target identity, early
Content-Length rejection, and streaming limits for chunked bodies. Verification precedes parse/log/
dedup/scope handling. Durable ingress and per-project application intents distinguish verified receipt
from complete fanout: a `PENDING` replay resumes application rather than returning success.

The injected-clock reconciliation scheduler persists due cursors, resumes incomplete deliveries/scans
at startup, applies bounded concurrency and exponential backoff/rate-limit `notBefore`, wakes on scope
changes, and stops cleanly during shutdown. Tests cover chunked overflow, unsupported encoding,
multi-project selected/unselected fanout, partial delivery replay, startup recovery, periodic wakeup,
rate-limit paging, epoch change mid-scan, and graceful shutdown.

- [ ] **Step 5: Run GREEN**

Run: `bun test tests/integration/github/webhook-reconciliation.test.ts tests/integration/github/reconciliation-scheduler.test.ts tests/drills/github-missed-webhook.test.ts && bun run typecheck`

Expected: PASS and one projection per source key.

- [ ] **Step 6: Commit**

```bash
git add src/server/adapters/github/webhooks.ts src/server/adapters/github/reconciliation.ts src/server/modules/github-coordination/reconciliation-scheduler.ts src/server/adapters/http/routes/connectors-github.ts src/server/app.ts tests/integration/github/webhook-reconciliation.test.ts tests/integration/github/reconciliation-scheduler.test.ts tests/drills/github-missed-webhook.test.ts
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
- Test: `tests/integration/github/mutation-recovery.test.ts`
- Test: `tests/protocol/github-surface-parity.test.ts`
- Test: `tests/e2e/github-planning.spec.ts`

**Interfaces:**
- Consumes: `GitHubPort.mutate`, Foundation `ConnectorAuthority`, optional consumed
  `ExecutionAuthority` operation authorization for attempt-originated writes, current epoch/scope, and
  exact source revision.
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
  const prepared = await connectorAuthority.prepareOperation(toConnectorOperation(command));
  if (!prepared.ok) return prepared;
  const observed = await github.mutate(prepared.value.authorization, prepared.value.command);
  if (!observed.ok) return await recordVisibleProviderFailure(command, observed.error);
  return await connectorAuthority.confirmMutation(toConfirmedProjection(prepared.value.intentId, observed.value));
}
```

`prepareOperation` commits the generic Foundation connector intent before the provider call. On
restart, inspect pending intents, revalidate current actor/connector authority, then use the operation's
deterministic non-secret marker or exact provider membership/object ID to distinguish applied,
unapplied, and ambiguous outcomes. Never match bodies. Applied recovery confirms the original provider
identity/projection once; unapplied recovery may retry only under fresh authorization; revoked/stale
intents remain `REQUIRES_REAUTHORIZATION`. Tests inject process loss before call, applied write plus
lost response, provider success plus local confirmation rollback, same-key replay/conflict, revocation,
and ambiguous marker collision across create/comment/milestone/Project membership operations.

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

Run: `bun test tests/integration/github/{issues,milestones,projects,revision-cas,mutation-recovery}.test.ts tests/protocol/github-surface-parity.test.ts && bun run test:e2e:run github-planning.spec.ts`

Expected: PASS; stale writes return `SOURCE_REVISION_STALE` and unselected items remain redacted.

- [ ] **Step 7: Commit**

```bash
git add src/server/adapters/github src/server/modules/github-coordination/mutations.ts src/server/adapters/http/routes/github-issues.ts src/server/adapters/http/routes/github-planning.ts src/server/adapters/mcp/github-tools.ts src/web/features/github tests/integration/github tests/protocol/github-surface-parity.test.ts tests/e2e/github-planning.spec.ts
git commit -m "feat(github): add provider-first planning mutations"
```

### Task 5: Canonical Coordination, Assignment, Delegation, and Delivery

**Requirements:** `GHB-006`, `GHB-007`, `GHB-008`.

**Files:**
- Create: `src/server/db/migrations/0008_coordination_source_mapping.sql`
- Create: `src/server/db/migrations/0008_coordination_source_mapping.verify.ts`
- Modify: `src/server/db/migrate.ts`
- Modify: `src/server/operations/{backup,restore}.ts`
- Modify: `src/server/modules/coordination-records/{canonical-key,source-links}.ts`
- Create: `src/server/modules/github-coordination/{assignment-delegation,delivery}.ts`
- Create: `src/server/adapters/http/routes/coordination-records.ts`
- Test: `tests/integration/coordination-records/{canonical-link,coalescing}.test.ts`
- Test: `tests/integration/github/{assignment-delegation,delivery}.test.ts`

**Interfaces:**
- Consumes: Foundation's existing canonical `(project_id, connector_id, source_item_id)` mapping,
  source-free Coordination Records, `ExecutionAuthority.execute` commands `LINK_SOURCE_REFERENCE` and
  `LAUNCH_RUN`, and bounded evidence recording.
- Produces: provider alias/provenance extensions to the canonical mapping, immutable record aliases,
  independent `AssignmentDelegationResult`, and closing-reference derivation.

- [ ] **Step 1: Write concurrent late-link and partial-success tests**

```ts
test("late-link race selects one record without rewriting completed run provenance", async () => {
  const [a, b] = await Promise.all([fixture.link(recordA, issue42), fixture.link(recordB, issue42)]);
  expect([a, b].filter((result) => result.ok)).toHaveLength(1);
  const winner = a.ok ? recordA : recordB;
  const loser = a.ok ? recordB : recordA;
  expect(await fixture.canonical(issue42)).toBe(winner);
  expect(await fixture.completedRunRecord(completedRun)).toBe(loser);
  expect(await fixture.aliasFor(loser)).toBe(winner);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/integration/coordination-records/canonical-link.test.ts tests/integration/coordination-records/coalescing.test.ts tests/integration/github/assignment-delegation.test.ts`

Expected: FAIL with missing canonical mapping migration.

- [ ] **Step 3: Add canonical and provenance tables**

```sql
CREATE TABLE github_source_aliases (
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES github_installations(connector_id),
  provider_alias_kind TEXT NOT NULL CHECK(provider_alias_kind IN ('REPOSITORY_NUMBER','NODE_ID','CANONICAL_URL')),
  provider_alias TEXT NOT NULL CHECK(length(provider_alias) BETWEEN 1 AND 512),
  source_item_id TEXT NOT NULL CHECK(length(source_item_id) BETWEEN 1 AND 512),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  PRIMARY KEY (project_id, connector_id, provider_alias_kind, provider_alias),
  FOREIGN KEY (project_id, connector_id, source_item_id)
    REFERENCES coordination_source_keys(project_id, connector_id, source_item_id)
) STRICT;
CREATE TABLE coordination_record_aliases (
  project_id TEXT NOT NULL REFERENCES projects(id),
  alias_record_id TEXT NOT NULL,
  canonical_record_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('AUTHORIZED_COALESCE')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  CHECK(alias_record_id <> canonical_record_id),
  PRIMARY KEY(project_id, alias_record_id),
  FOREIGN KEY(project_id, alias_record_id) REFERENCES coordination_records(project_id, id),
  FOREIGN KEY(project_id, canonical_record_id) REFERENCES coordination_records(project_id, id)
) STRICT;
```

Migration `0008` extends rather than recreates Foundation's canonical source mapping and is wired into
the contiguous migrator. Linking uses the immutable provider ID-based `source_item_id`; mutable
owner/repository/number URLs are aliases only. Late-link races have one canonical winner under the
Foundation unique key. Coalescing never rewrites completed run provenance and requires explicit
authorized aliasing with auditable reason. The transaction requires the target to be canonical,
rejects cross-project aliases, chains and cycles, moves only non-terminal run/source/proposal/evidence/
mutation-reservation references atomically, and preserves completed histories on the loser with a
one-hop alias. Injected rollback at every move proves no partial coalescing.

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
  const repository = requireFreshScopedRepositoryProjection(issue.repositoryId);
  return `Closes ${repository.ownerLogin}/${repository.name}#${issue.number}`;
}
// PR merge updates only the PR projection; issue closure changes only after GitHub reports CLOSED.
```

Mutable repository owner/name comes from a fresh authorized projection, never the identity reference.
Tests cover rename, cross-repository syntax, target/base-branch rules, disabled auto-close, merged/open,
external closure, and reopen. Assignment and delegation remain independent results and retries.

- [ ] **Step 6: Run GREEN**

Run: `bun test src/server/db/migrations/0008_coordination_source_mapping.verify.ts tests/integration/coordination-records tests/integration/github/assignment-delegation.test.ts tests/integration/github/delivery.test.ts tests/drills/backup-restore.test.ts`

Expected: PASS; partial successes remain independently retryable and merged/open remains visible.

- [ ] **Step 7: Commit**

```bash
git add src/server/db/migrations/0008_coordination_source_mapping.sql src/server/db/migrations/0008_coordination_source_mapping.verify.ts src/server/db/migrate.ts src/server/operations/backup.ts src/server/operations/restore.ts src/server/modules/coordination-records src/server/modules/github-coordination/assignment-delegation.ts src/server/modules/github-coordination/delivery.ts src/server/adapters/http/routes/coordination-records.ts tests/integration/coordination-records tests/integration/github/assignment-delegation.test.ts tests/integration/github/delivery.test.ts tests/drills/backup-restore.test.ts
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
export const ChangedPathSnapshotSchema = ChangedPathsEvidenceSchema.extend({
  runId: AgentRunIdSchema,
  observedAt: InstantSchema,
}).strict();
```

Reuse the Foundation repository-relative path and changed-path evidence schemas exactly, including
Windows/backslash/dot-segment rules and canonical count/byte/truncation bounds. Capture at checkpoint,
attempt exit, and pre-publish. A mutating run cannot claim deliverable-ready without required bounded
diff evidence. Retain while a linked PR or Retained Local Work remains; after terminal purge, preserve
only path-free collision facts and bounded statistics.

- [ ] **Step 4: Implement exact-SHA checks and non-authoritative dependencies**

```ts
export function evaluateCheck(observation: GitHubCheckObservation, published: PublishedGitReference): Result<GitHubCheckEvidence> {
  if (observation.scopeDigest !== published.scopeDigest || observation.repositoryId !== published.repositoryId || observation.commitSha !== published.commitSha || observation.checkName !== published.requiredCheckName || !observation.fresh) return failure("GATE_EVALUATION_STALE", "REFRESH");
  return success({ checkRunId: observation.checkRunId, commitSha: observation.commitSha, conclusion: observation.conclusion });
}
export const dependencyWarning = (value: Observed<readonly SourceDependency[]>): SourceDependencyView => ({
  freshness: value.freshness, dependencies: value.value, blocksLaunch: false, changesRunState: false,
});
```

Check evidence binds current connector scope/epoch, immutable repository/remote identity, exact
Published Git Reference SHA, expected check name, acceptable conclusion, observation time and
freshness/provenance. Dependencies remain advisory under unresolved/resolved/stale/unavailable states
and never block launch or mutate run state.

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
- Create: `src/server/db/migrations/0009_github_attention.sql`
- Create: `src/server/db/migrations/0009_github_attention.verify.ts`
- Modify: `src/server/db/migrate.ts`
- Modify: `src/server/operations/{backup,restore}.ts`
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
  recipient_member_id TEXT NOT NULL REFERENCES members(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('ACTION_REQUIRED','BLOCKED','WARNING','OUTCOME')),
  event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 128),
  subject_key TEXT NOT NULL CHECK(length(subject_key) BETWEEN 1 AND 512),
  category TEXT NOT NULL CHECK (category IN ('ACTION_REQUIRED','BLOCKED','WARNING','OUTCOME')),
  material_digest TEXT NOT NULL CHECK(length(material_digest) = 64 AND material_digest NOT GLOB '*[^a-f0-9]*'),
  safe_summary TEXT NOT NULL CHECK(length(safe_summary) BETWEEN 1 AND 240),
  unread INTEGER NOT NULL CHECK (unread IN (0,1)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  last_material_change_at INTEGER NOT NULL CHECK(last_material_change_at >= created_at),
  read_at INTEGER CHECK(read_at >= created_at),
  resolved_at INTEGER CHECK(resolved_at >= 0),
  resolution_reason TEXT CHECK(resolution_reason IS NULL OR resolution_reason IN ('SOURCE_RESOLVED','MEMBER_DISMISSED','SUPERSEDED','RETENTION_EXPIRED')),
  source_revision TEXT CHECK(source_revision IS NULL OR length(source_revision) BETWEEN 1 AND 256),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY (recipient_member_id, event_type, subject_key)
) STRICT;
CREATE INDEX inbox_items_recipient_unread_idx ON inbox_items(recipient_member_id, unread, updated_at);
CREATE INDEX inbox_items_resolved_retention_idx ON inbox_items(resolved_at) WHERE resolved_at IS NOT NULL;
```

- [ ] **Step 4: Implement epoch-first revocation and non-authoritative UI actions**

```ts
const committed = await connectorAuthority.narrowScopeAndAdvanceEpoch(command);
if (!committed.ok) return committed;
await revocationDispatcher.deliver(committed.value.durableIntentId);
// Command Center card actions call typed commands; lane movement has no write handler.
```

Inbox derivation retains a concrete committed event/reference and material-state digest. Read state is
personal and revisioned; a duplicate or heartbeat/receipt/refresh/progress event does not create or
re-unread an item, while a changed material digest does. Fake-clock tests enforce 90-day resolved
retention. Command Center lanes are derived only and never stored or draggable.

Scope narrowing and connector epoch advance commit first with a durable revocation intent. Immediate
authorization checks read the new epoch even if notification fails. The dispatcher is idempotent and
startup-resumable; crash after epoch commit before notification never restores access.

- [ ] **Step 5: Run GREEN and browser verification**

Run: `bun test src/server/db/migrations/0009_github_attention.verify.ts tests/drills/github-scope-narrowing.test.ts tests/drills/github-member-offboarding.test.ts tests/integration/inbox/github-attention.test.ts tests/drills/backup-restore.test.ts && bun run test:e2e:run github-attention.spec.ts`

Expected: PASS; removed authority fails immediately and cards expose no drag lifecycle mutation.

- [ ] **Step 6: Commit**

```bash
git add src/server/db/migrations/0009_github_attention.sql src/server/db/migrations/0009_github_attention.verify.ts src/server/db/migrate.ts src/server/operations/backup.ts src/server/operations/restore.ts src/server/modules/inbox src/web/features/inbox src/web/features/command-center src/web/app.tsx tests/drills/github-scope-narrowing.test.ts tests/drills/github-member-offboarding.test.ts tests/integration/inbox/github-attention.test.ts tests/drills/backup-restore.test.ts tests/e2e/github-attention.spec.ts
git commit -m "feat(github): project revocation and team attention"
```

### Task 8: Strict Fixture Journey, Live Ledger, and Phase Gate

**Requirements:** `GHB-015` and final evidence for `GHB-001` through `GHB-014`.

**Files:**
- Create: `tests/e2e/github-delivery.spec.ts`
- Create: `tests/e2e/github-live-{planning,delivery,checks}.spec.ts`
- Create: `tests/drills/github-storage-canary.test.ts`
- Create: `tests/evidence/github-matrix.ts`
- Create: `tests/unit/evidence/github-matrix.test.ts`
- Create: `scripts/github-evidence.ts`
- Create: `docs/evidence/github/EVIDENCE-TEMPLATE.md`
- Create: `docs/evidence/github/<build-id>.md`
- Create: `docs/evidence/github/LIVE-DOGFOOD-LEDGER.md`
- Modify: `package.json`
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
const canaries = generateGitHubStorageCanaries();
await fixture.injectEveryAllowedAndProhibitedChannel(canaries);
await exerciseSearchMutationReconciliationBackup();
const stores = await inspectEveryExpectedGitHubStore();
expect(stores.map((store) => store.id).sort()).toEqual(EXPECTED_GITHUB_STORE_IDS);
for (const store of stores) for (const encoding of forbiddenCanaryEncodings(canaries.forbidden)) expect(store.bytes.includes(encoding)).toBe(false);
```

Use distinct runtime-generated canaries for selected issue/comment bodies, unselected Project item
title/body/labels/actor, raw webhook, provider error, App private key, webhook secret, installation
token, raw diff, and POSIX/Windows absolute paths. Extend the Foundation closed inventory with every
GitHub/connector/idempotency/audit/projection/operation-intent/webhook/application/inbox/alias table,
logs/temp/staging, authenticated backup plus independently restored logical contents, runner/CLI/
browser/network/Playwright/container stores, evidence files and manifests. Missing, unreadable,
skipped, or unexpected stores fail. Search raw/JSON/URL/base64 forms; ciphertext-only scanning is not
proof.

- [ ] **Step 4: Create exact evidence templates**

```markdown
| Requirement | Build | Git revision | GitHub resource/revision | Collab record/run/audit IDs | Journey/command | Result | Reviewer | Blocker |
|---|---|---|---|---|---|---|---|---|
```

The neutral template starts `NOT_RUN`; a separate build-specific record captures exact tested commit,
dirty state, artifact/manifest/image digests, individual commands/results and local requirement status.
The strict registry maps `GHB-001` through `GHB-015` to exact local and live test names and derives
`NOT_STARTED|LOCAL_PROOF_COMPLETE|IN_PROGRESS_LIVE|BLOCKED_ENV|PASS|FAIL`. A skipped, fixture-only,
blocked, failed, unreviewed, or build-mismatched obligation cannot pass. `github-evidence` parses
Playwright JSON rather than trusting process exit and validates disposable installation/repository/
Project IDs plus an explicit human approval ID; unknown or production-looking targets are refused.

Live named cases cover every issue mutation, Milestones, Projects, stale edit, missed webhook, late
link, scope narrowing, exact-SHA checks, publish, GitHub-native review/merge, and observed issue closure.
Review/merge remain recorded external GitHub actions, never Collab mutations. Until authorized live
execution, the ledger stays `IN_PROGRESS_LIVE`/`BLOCKED_ENV` and human reviewer `UNREVIEWED`.

- [ ] **Step 5: Run the local GitHub gate GREEN**

Run: `bun test tests/unit/github tests/integration/github tests/integration/coordination-records tests/integration/evidence tests/integration/inbox tests/protocol/github-surface-parity.test.ts tests/drills/github-*.test.ts && bun run test:e2e:run github-planning.spec.ts github-attention.spec.ts github-delivery.spec.ts`

Expected: PASS and exit 0; live-only ledger rows remain `IN_PROGRESS` or `BLOCKED` until executed.

- [ ] **Step 6: Execute authorized disposable live evidence**

Run only with explicit disposable-target approval: `COLLAB_LIVE_GITHUB=1 bun run test:e2e:run github-live-planning.spec.ts github-live-delivery.spec.ts github-live-checks.spec.ts --reporter=json` followed by `bun run github:evidence validate-live <playwright-json>`.

Expected: PASS only with an explicitly approved disposable installation; otherwise SKIP with `LIVE_GITHUB_NOT_AUTHORIZED`, recorded as `BLOCKED`, never `PASS`.

- [ ] **Step 7: Run the full package gate**

Run each separately and record its result: the exact AGENTS sequence; `bun run archive:verify`; GitHub
evidence validation; compiled CLI smoke; packaged server readiness/shutdown; hardened container
readiness; authenticated backup/verify and isolated restore; placeholder scan; and `git diff --check`.
Use `tests/scripts/compose-config-with-temporary-secrets.sh`, never `.env.example` as secret material.
After the final intended evidence/source inventory, run `manifest:generate`, then `manifest:verify` and
`archive:verify`. Preserve the tested-build manifest separation so the evidence commit does not claim
to be the tested implementation commit.

Expected: every locally achievable command exits 0 and is recorded independently. Environment/live
failures remain separate; an unrun command does not inherit success and a skipped live suite is not a
pass.

- [ ] **Step 8: Commit**

```bash
git add tests/e2e/github-delivery.spec.ts tests/e2e/github-live-planning.spec.ts tests/e2e/github-live-delivery.spec.ts tests/e2e/github-live-checks.spec.ts tests/drills/github-storage-canary.test.ts tests/evidence/github-matrix.ts tests/unit/evidence/github-matrix.test.ts scripts/github-evidence.ts docs/evidence/github package.json MANIFEST.md MANIFEST.sha256
git commit -m "test(github): record authoritative delivery evidence"
```
