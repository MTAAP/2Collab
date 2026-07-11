# Outline Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `OUT-001` through `OUT-010` so two members and authorized Agent Runs collaborate bidirectionally through Outline with native attribution, exact grants/revisions, safe conflict proposals, revocation, and source-body minimization.

**Architecture:** Separate narrow `OutlineContentPort` and `OutlineOAuthProviderPort` true-external
seams prevent live document bodies/token sets from entering persistent projection contracts. Delegated
member OAuth performs direct human creation/edits; one team bot identity performs agent reads,
proposals, and exact-grant writes. All paths consume Foundation credential encryption, connector
epochs/scopes, exact-revision operation authorization, audit, reconciliation, Context Recipe,
source-reference, and `ExecutionAuthority` primitives.

**Tech Stack:** Bun 1.3.10, TypeScript 7.0.2, Hono 4.12.29, React 19.2.7, Zod 4.4.3, `bun:sqlite`, OAuth 2.0 with PKCE, Bun test, Playwright 1.61.1, Outline API.

## Global Constraints

- Use Bun 1.3.10, one root `package.json`, and one `bun.lock`; pin every dependency exactly.
- The Product Spec is canonical; Outline owns document bodies, revisions, collection placement, sharing, permissions, archive state, and native identity attribution.
- Import Foundation credential encryption, connector epoch/scope, exact-revision operation authorization, audit, reconciliation, Context Recipe, source-reference, offboarding, and `ExecutionAuthority` primitives; do not recreate them.
- Direct human writes require the authenticated member's delegated OAuth identity; agent reads/writes use the team bot and exact run provenance. Never impersonate a member with the bot.
- A Document Write Grant binds one Agent Run, exact named documents, a closed non-destructive operation set, expiry, connector epoch, grant revision, and current source revision.
- Conflict proposals persist source identifiers/revisions plus the bounded agent-authored proposal or patch only. Fetch current source bodies from Outline during authorized resolution; never persist fetched base/current bodies.
- Persist references, revisions, bounded authored patches, decisions, provenance, and safe metadata; never persist fetched document bodies in coordination tables, audit, logs, backups, or runner outboxes.
- No generic Outline endpoint, arbitrary document ID outside current scope, generic Markdown mutation, provider payload, command, executable, argument, environment, or shell escape hatch.
- Local fixture evidence cannot mark a live acceptance requirement `PASS`; keep it `IN_PROGRESS` or `BLOCKED` until disposable-workspace proof exists.
- Start every executable behavior with an observed failing Bun test and make the smallest implementation pass.
- Do not mutate production Outline knowledge or external integrations without explicit authority.

---

## File Map

- `src/shared/contracts/outline.ts`: Outline references, projections, identities, scopes, reads, exact mutations, and Zod schemas.
- `src/shared/contracts/document-grants.ts`: exact grant and additional-document request schemas.
- `src/shared/contracts/document-proposals.ts`: authored patches, conflict references, decisions, and working-document dispositions.
- `src/server/db/migrations/0009_outline.sql`: bot connection, delegated OAuth metadata, Context Read Scopes, document references, and access provenance.
- `src/server/db/migrations/0010_outline_grants.sql`: exact write grants and additional-document requests.
- `src/server/db/migrations/0011_outline_proposals.sql`: proposals, conflicts, and working-document references/dispositions without fetched bodies.
- `src/server/adapters/outline/{contract,oauth-provider-contract}.ts`: body-safe content and internal OAuth provider ports.
- `src/server/adapters/outline/{oauth,bot-auth,client,scope,search,documents,human-editing,revision-cas}.ts`: production provider adapter.
- `src/server/modules/documents/{human-editing,write-grants,additional-document-requests,agent-operations,proposals,conflicts,working-documents,revocation}.ts`: document collaboration policy over Foundation authority.
- `src/server/modules/federated-search/{contract,search}.ts`, `src/server/modules/context/outline-reference-provider.ts`: live reference-first search/read integration.
- `src/server/adapters/http/routes/{connectors-outline,outline-search,outline-documents}.ts`: thin HTTP adapters.
- `src/server/adapters/mcp/{outline-tools,document-tools}.ts`: thin MCP adapters.
- `src/web/features/outline/{connection,search,editor,proposals,working-documents}/`: user-visible collaboration surfaces.
- `tests/fixtures/outline/strict-outline-adapter.ts`: deterministic identities, scope, revisions, faults, and call log.
- `docs/evidence/outline/EVIDENCE-TEMPLATE.md`, `docs/evidence/outline/LIVE-DOGFOOD-LEDGER.md`: exact local/live evidence created during implementation.

### Task 1: Outline Contracts, Split Identities, and Persistence

**Requirements:** Contract and migration prerequisites for `OUT-001`, `OUT-002`, and `OUT-003`.

**Files:**
- Create: `src/shared/contracts/outline.ts`
- Create: `src/server/adapters/outline/{contract,oauth-provider-contract}.ts`
- Create: `src/server/modules/connectors/outline-credentials.ts`
- Create: `src/server/db/migrations/0009_outline.sql`
- Create: `src/server/db/migrations/0009_outline.verify.ts`
- Modify: `src/server/db/migrate.ts`
- Modify: `src/server/operations/{backup,restore}.ts`
- Modify: `src/server/operations/{backup,restore}.ts`
- Test: `tests/unit/outline/contracts.test.ts`
- Test: `tests/integration/outline/migration-0009.test.ts`
- Test: `tests/integration/outline/{oauth-transaction,projection-storage-safety}.test.ts`
- Test: `tests/drills/backup-restore.test.ts`

**Interfaces:**
- Consumes: Foundation `Result<T>`, `EphemeralObserved<T>`, `Observed<T>`, typed-precondition
  `ExactRevisionMutation<T>`, `ScopedSearch`, `ContextReference`, and body-safe
  `ContextConnector<TReference,TLiveRead,TProjection,TMutation>`.
- Produces:

```ts
export interface OutlineContentPort
  extends ContextConnector<OutlineReference, OutlineReadResult, OutlineDocumentProjection, OutlineMutation> {}
export interface OutlineReconciliationPort {
  inspectSafe(scope: ConnectorScope, reference: OutlineReference): Promise<Result<Observed<OutlineDocumentProjection>>>;
  scanSafe(scope: ConnectorScope, cursor?: ReconciliationCursor): AsyncIterable<Result<ReconciliationEvent<OutlineDocumentProjection>>>;
}
export interface OutlineOAuthProviderPort {
  discover(origin: CanonicalOutlineOrigin): Promise<Result<VerifiedOutlineOAuthMetadata>>;
  exchange(transaction: VerifiedOutlineOAuthTransaction, authorizationCode: string): Promise<Result<ProviderTokenSet>>;
  refresh(grant: EncryptedOutlineOAuthGrant): Promise<Result<ProviderTokenSet>>;
  revoke(grant: EncryptedOutlineOAuthGrant): Promise<Result<ProviderRevocationResult>>;
  inspectIdentity(access: EphemeralProviderAccess): Promise<Result<OutlineProviderIdentity>>;
}

export type OutlineMutation =
  | { kind: "CREATE_DOCUMENT_AS_MEMBER"; collectionId: string; title: string; body: string }
  | { kind: "EDIT_DOCUMENT_AS_MEMBER"; documentId: string; authoredPatch: AuthoredDocumentPatch }
  | { kind: "EDIT_DOCUMENT_AS_BOT"; provenance: BotDocumentOperationProvenance; documentId: string; authoredPatch: AuthoredDocumentPatch }
  | { kind: "APPLY_PROPOSAL_AS_MEMBER"; proposalId: DocumentProposalId; documentId: string }
  | { kind: "PROMOTE_WORKING_DOCUMENT"; workingDocumentId: WorkingDocumentId; targetCollectionId: string; title: string }
  | { kind: "ARCHIVE_WORKING_DOCUMENT"; workingDocumentId: WorkingDocumentId };
```

`OutlineReadResult` may contain the response-only live body and never enters ConnectorAuthority.
`OutlineDocumentProjection` contains only immutable document/workspace identity, observed current
collection, bounded title, source revision/comparable digest/source time/freshness/archive state and
safe provider actor provenance. Mutation confirmation reparses through its strict codec, persists and
idempotently replays only that projection, and cannot accept a live-read value. Human provider identity
is derived from the authenticated Member's current `(connector, member)` OAuth grant; callers cannot
select a delegated identity. Bot provenance binds run, attempt, grant ID/revision, grantor Member,
connector epoch and edited source revision.

The separate reconciliation port reads provider metadata through a body-discarding adapter and emits
only codec-validated safe projections/events. Periodic refresh and mutation confirmation apply through
Foundation `ConnectorAuthority.reconcileSource`; a `ContextConnector` itself has no scan and no live
body can enter reconciliation.

- [ ] **Step 1: Write schema and identity-separation tests**

```ts
test("rejects generic endpoints and bot-authored human edits", () => {
  expect(OutlineMutationSchema.safeParse({ kind: "RAW_API", path: "/documents.delete" }).success).toBe(false);
  expect(OutlineMutationSchema.safeParse({ kind: "EDIT_DOCUMENT_AS_MEMBER", identity: { kind: "BOT" } }).success).toBe(false);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/unit/outline/contracts.test.ts`

Expected: FAIL with missing `src/shared/contracts/outline.ts`.

- [ ] **Step 3: Add split-identity and reference-only tables**

```sql
CREATE TABLE outline_connections (
  connector_id TEXT PRIMARY KEY REFERENCES connector_epochs(connector_id),
  origin TEXT NOT NULL CHECK(length(origin) BETWEEN 8 AND 2048),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 128),
  bot_provider_user_id TEXT NOT NULL CHECK(length(bot_provider_user_id) BETWEEN 1 AND 128),
  bot_credential_id TEXT NOT NULL REFERENCES encrypted_credentials(id),
  oauth_client_id TEXT NOT NULL CHECK(length(oauth_client_id) BETWEEN 1 AND 256),
  oauth_client_secret_credential_id TEXT REFERENCES encrypted_credentials(id),
  oauth_metadata_digest TEXT NOT NULL CHECK(length(oauth_metadata_digest) = 64 AND oauth_metadata_digest NOT GLOB '*[^a-f0-9]*'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  UNIQUE(origin, workspace_id)
) STRICT;
CREATE TABLE outline_member_oauth_grants (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  connector_id TEXT NOT NULL REFERENCES outline_connections(connector_id),
  member_id TEXT NOT NULL REFERENCES members(id),
  outline_user_id TEXT NOT NULL CHECK(length(outline_user_id) BETWEEN 1 AND 128),
  credential_id TEXT NOT NULL REFERENCES encrypted_credentials(id),
  granted_scope_digest TEXT NOT NULL CHECK(length(granted_scope_digest) = 64 AND granted_scope_digest NOT GLOB '*[^a-f0-9]*'),
  access_expires_at INTEGER NOT NULL CHECK(access_expires_at >= 0),
  refresh_status TEXT NOT NULL CHECK(refresh_status IN ('READY','ROTATING','REAUTHORIZATION_REQUIRED','REVOKED')),
  credential_revision INTEGER NOT NULL CHECK(credential_revision > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  revoked_at INTEGER CHECK(revoked_at >= created_at),
  UNIQUE(connector_id, member_id),
  UNIQUE(connector_id, outline_user_id)
) STRICT;
CREATE TABLE outline_oauth_transactions (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  connector_id TEXT NOT NULL REFERENCES outline_connections(connector_id),
  member_id TEXT NOT NULL REFERENCES members(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  state_hash BLOB NOT NULL UNIQUE CHECK(length(state_hash) = 32),
  redirect_origin_digest TEXT NOT NULL CHECK(length(redirect_origin_digest) = 64 AND redirect_origin_digest NOT GLOB '*[^a-f0-9]*'),
  pkce_challenge TEXT NOT NULL CHECK(length(pkce_challenge) BETWEEN 43 AND 128),
  pkce_method TEXT NOT NULL CHECK(pkce_method = 'S256'),
  verifier_credential_id TEXT NOT NULL REFERENCES encrypted_credentials(id),
  requested_scope_digest TEXT NOT NULL CHECK(length(requested_scope_digest) = 64 AND requested_scope_digest NOT GLOB '*[^a-f0-9]*'),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  consumed_at INTEGER CHECK(consumed_at >= created_at),
  revoked_at INTEGER CHECK(revoked_at >= created_at),
  revision INTEGER NOT NULL CHECK(revision > 0),
  CHECK(expires_at = created_at + 600)
) STRICT;
CREATE TABLE outline_document_references (
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES outline_connections(connector_id),
  document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 128),
  observed_collection_id TEXT NOT NULL CHECK(length(observed_collection_id) BETWEEN 1 AND 128),
  safe_title TEXT NOT NULL CHECK(length(safe_title) BETWEEN 1 AND 240),
  source_revision TEXT NOT NULL CHECK(length(source_revision) BETWEEN 1 AND 256),
  comparable_digest TEXT NOT NULL CHECK(length(comparable_digest) = 64 AND comparable_digest NOT GLOB '*[^a-f0-9]*'),
  source_updated_at INTEGER CHECK(source_updated_at >= 0),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  freshness TEXT NOT NULL CHECK(freshness IN ('FRESH','STALE','UNAVAILABLE','REDACTED')),
  provenance_kind TEXT NOT NULL CHECK(provenance_kind IN ('SEARCH','READ','MUTATION_CONFIRMATION','RECONCILIATION')),
  provider_actor_id TEXT CHECK(provider_actor_id IS NULL OR length(provider_actor_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY (project_id, connector_id, document_id)
) STRICT;
CREATE TABLE outline_access_provenance (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES outline_connections(connector_id),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('MEMBER','RUN_ATTEMPT')),
  member_id TEXT REFERENCES members(id),
  run_id TEXT REFERENCES agent_runs(id),
  attempt_id TEXT REFERENCES execution_attempts(id),
  document_id TEXT,
  observed_revision TEXT CHECK(observed_revision IS NULL OR length(observed_revision) BETWEEN 1 AND 256),
  result TEXT NOT NULL CHECK(result IN ('ALLOWED','STALE','UNAVAILABLE','FORBIDDEN','REDACTED')),
  connector_epoch INTEGER NOT NULL CHECK(connector_epoch > 0),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
  correlation_digest TEXT CHECK(correlation_digest IS NULL OR (length(correlation_digest) = 64 AND correlation_digest NOT GLOB '*[^a-f0-9]*')),
  CHECK((actor_kind = 'MEMBER' AND member_id IS NOT NULL AND run_id IS NULL AND attempt_id IS NULL) OR (actor_kind = 'RUN_ATTEMPT' AND member_id IS NULL AND run_id IS NOT NULL AND attempt_id IS NOT NULL)),
  FOREIGN KEY(project_id, connector_id, document_id) REFERENCES outline_document_references(project_id, connector_id, document_id)
) STRICT;
```

Foundation `connector_scope_references` remains the only Context Read Scope authority, using canonical
`OUTLINE_COLLECTION:<immutable-id>` entries; there is no duplicate Outline scope revision. Document
collection in a reference is observed metadata only. Search returns only scoped collections; read/
write refresh current native collection and intersect provider permission with current Foundation
scope. A move to denied scope before read/write redacts/fails without leaking identifier/title/body.

V1 uses a registered confidential OAuth client plus authorization-code PKCE `S256`; connector setup
discovers and pins the exact Outline origin/workspace OAuth metadata digest and fails
`OUTLINE_OAUTH_CAPABILITY_UNSUPPORTED` unless authorization, token, refresh, revocation and PKCE S256
capabilities are confirmed. It does not depend on optional dynamic client registration. Transactions
are restart-safe, ten-minute, state-hash/session/member/connector/redirect/scope-bound, single-use, and
store the verifier only through the encrypted credential store. Outline access/refresh lifetimes are
provider-observed; refresh rotation/replay and local revocation remain Foundation authority.

Member OAuth, configured bot identity, Context Read Scope, and Document Write Grant are independent
authorities. Token sets pass directly from the provider port to encrypted storage and never appear in
shared schemas. Local revoke/epoch advance commits before best-effort provider revocation and cannot be
reactivated by provider failure. Bot inspection proves the configured provider user exactly.

- [ ] **Step 4: Implement the closed schemas and split ports exactly as shown**

```ts
export const AuthoredDocumentPatchSchema = z.object({
  format: z.literal("UNIFIED_TEXT_PATCH_V1"),
  value: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export async function validateAuthoredDocumentPatch(input: unknown): Promise<Result<AuthoredDocumentPatch>> {
  const parsed = AuthoredDocumentPatchSchema.safeParse(input);
  if (!parsed.success) return failure("OUTLINE_PATCH_INVALID", "NEVER");
  const bytes = new TextEncoder().encode(parsed.data.value);
  if (bytes.byteLength > 131_072 || !isValidUnifiedTextPatch(bytes) || await sha256Hex(bytes) !== parsed.data.digest) return failure("OUTLINE_PATCH_INVALID", "NEVER");
  return success(parsed.data);
}
```

Reject binary/control content, malformed/oversized hunks, digest mismatch, no-op mutations, unknown
nested keys, identity selection, and nested authority/revision fields. `ABSENT` is the outer
precondition for creation; edits/apply/promote/archive use `EXACT_REVISION`. Re-read current document
revision and native collection immediately before write, serialize bot writes per document, then
read/normalize confirmation and report `ATOMIC` only when the pinned provider explicitly proves CAS;
otherwise `RESIDUAL_RACE`. Conflicts create authored proposals, never overwrite retries. Durable
patches are deliberate bounded deltas and cannot contain a disguised full fetched body.

- [ ] **Step 5: Run GREEN**

Run: `bun test tests/unit/outline/contracts.test.ts tests/integration/outline/migration-0009.test.ts tests/integration/outline/oauth-transaction.test.ts tests/integration/outline/projection-storage-safety.test.ts src/server/db/migrations/0009_outline.verify.ts tests/drills/backup-restore.test.ts && bun run typecheck`

Expected: PASS and exit 0. Verify empty-to-v9 and v8-to-v9 upgrade, rollback/history/integrity/FKs,
preserved Foundation/GitHub data, and authenticated schema-8 backup restore through isolated staged
migration. Restore advances the Outline connector epoch, marks it `REVIEW_REQUIRED`, invalidates member
OAuth/bot operation authorizations, holds pending writes, and never resumes an old grant/token. Body
canaries are absent from projections, idempotency, intents, audit, SQLite/WAL/SHM and restored logical
backup data.

- [ ] **Step 6: Commit**

```bash
git add src/shared/contracts/outline.ts src/server/adapters/outline/contract.ts src/server/adapters/outline/oauth-provider-contract.ts src/server/modules/connectors/outline-credentials.ts src/server/db/migrations/0009_outline.sql src/server/db/migrations/0009_outline.verify.ts src/server/db/migrate.ts src/server/operations/backup.ts src/server/operations/restore.ts tests/unit/outline/contracts.test.ts tests/integration/outline/migration-0009.test.ts tests/integration/outline/oauth-transaction.test.ts tests/integration/outline/projection-storage-safety.test.ts tests/drills/backup-restore.test.ts
git commit -m "feat(outline): define split-identity contracts"
```

### Task 2: OAuth, Bot Authentication, Context Read Scope, and Strict Adapter

**Requirements:** `OUT-001`, `OUT-002`.

**Files:**
- Create: `src/server/adapters/outline/{oauth,bot-auth,client,scope}.ts`
- Create: `src/server/adapters/http/routes/connectors-outline.ts`
- Create: `src/web/features/outline/connection/index.tsx`
- Create: `tests/fixtures/outline/strict-outline-adapter.ts`
- Test: `tests/integration/outline/{oauth,bot-attribution,scope}.test.ts`
- Test: `tests/e2e/outline-connection.spec.ts`

**Interfaces:**
- Consumes: Foundation encrypted credential store, connector epochs/scopes, authenticated Member identity, CSRF/session policy, and audit.
- Produces: `beginOutlineOAuth`, `finishOutlineOAuth`, `resolveOutlineIdentity`,
  `assertOutlineScope`, `StrictOutlineContentAdapter implements OutlineContentPort`, and a separate
  `StrictOutlineOAuthProvider implements OutlineOAuthProviderPort`.

- [ ] **Step 1: Write OAuth, attribution, and denied-collection tests**

```ts
test("keeps delegated member and bot authority distinct", async () => {
  const outline = StrictOutlineAdapter.seed({ allowedCollections: ["allowed"], deniedCollections: ["denied"] });
  await outline.mutate(memberAuthorization("mem_a"), memberEdit({ documentId: "doc_a" }));
  await outline.mutate(botAuthorization({ runId: "run_a", attemptId: "att_a", grantId: "grant_a" }), botEdit({ documentId: "doc_a" }));
  expect(outline.calls.map((call) => call.actor)).toEqual(["OUTLINE_MEMBER:mem_a", "OUTLINE_BOT:run_a"]);
  const denied = await outline.read(scopedCollections(["allowed"]), { workspaceId: "ws_a", documentId: "doc_denied" });
  expect(denied.ok).toBe(false);
  if (denied.ok) throw new Error("expected scope denial");
  expect(denied.error.code).toBe("OUTLINE_SCOPE_DENIED");
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/integration/outline/oauth.test.ts tests/integration/outline/bot-attribution.test.ts tests/integration/outline/scope.test.ts`

Expected: FAIL with missing strict adapter and OAuth modules.

- [ ] **Step 3: Implement PKCE/state callback binding and identity resolution**

```ts
export function resolveOutlineIdentity(request: OutlineIdentityRequest): Result<OutlineIdentity> {
  if (request.operation === "HUMAN_WRITE" && !request.authorization.memberOAuthGrant) return failure("OUTLINE_MEMBER_GRANT_REQUIRED", "EXPLICIT_RESUME");
  if (request.operation === "AGENT_OPERATION" && !request.authorization.botProvenance) return failure("RUN_AUTHORITY_REQUIRED", "NEVER");
  return success(request.operation === "HUMAN_WRITE"
    ? deriveMemberIdentityFromAuthorization(request.authorization)
    : deriveBotIdentityAndProvenance(request.authorization));
}
```

OAuth callbacks bind connector, authenticated Member, browser session/device, state hash, exact
redirect origin, PKCE verifier/challenge and requested scope digest. Reject replay, expiry, redirect/
member/session/connector swap, code reuse, callback after epoch change, provider identity change, and
offboarding races. Concurrent refresh rotation has one winner and reuse forces local reauthorization.
Human and bot credential classes cannot be swapped. Provider failure after local revoke never
reactivates authority.

- [ ] **Step 4: Implement the stateful strict adapter with revision and fault controls**

```ts
export class StrictOutlineContentAdapter implements OutlineContentPort {
  readonly calls: OutlineCall[] = [];
  private readonly documents = new Map<string, FixtureDocument>();
  private nextFault: OutlineFixtureFault | undefined;
  changeExternally(documentId: string, body: string): void { this.replace(documentId, body, "EXTERNAL_MEMBER"); }
  failNext(fault: OutlineFixtureFault): void { this.nextFault = fault; }
  async search(scope: ConnectorScope, query: ScopedSearch): Promise<Result<readonly ContextReference[]>> {
    return searchFixtureDocuments(this.documents, this.calls, scope, query);
  }
  async read(scope: ConnectorScope, reference: OutlineReference): Promise<Result<EphemeralObserved<OutlineReadResult>>> {
    return readFixtureDocument(this.documents, this.calls, scope, reference);
  }
  async mutate(authorization: ConnectorOperationAuthorization, command: ExactRevisionMutation<OutlineMutation>): Promise<Result<Observed<OutlineDocumentProjection>>> {
    return mutateFixtureDocument(this.documents, this.calls, authorization, command, this.consumeFault());
  }
}
```

The strict content adapter re-resolves the document's actual current collection on every search/read/
write and intersects it with Foundation collection references; a caller-supplied/old collection is
never authority. It satisfies the port at compile time. The separate strict OAuth provider returns
internal token sets to encrypted storage and simulates metadata capabilities, rotation, identity
changes, revoke failure and expiry without exposing tokens through shared/browser types.

- [ ] **Step 5: Run GREEN and browser proof**

Run: `bun test tests/integration/outline/{oauth,bot-attribution,scope}.test.ts && bun run test:e2e:run outline-connection.spec.ts`

Expected: PASS; tokens never appear in browser responses, audit, or adapter-safe summaries.

- [ ] **Step 6: Commit**

```bash
git add src/server/adapters/outline src/server/adapters/http/routes/connectors-outline.ts src/web/features/outline/connection tests/fixtures/outline/strict-outline-adapter.ts tests/integration/outline/oauth.test.ts tests/integration/outline/bot-attribution.test.ts tests/integration/outline/scope.test.ts tests/e2e/outline-connection.spec.ts
git commit -m "feat(outline): separate member and bot authority"
```

### Task 3: Federated Search, Reads, and Data Minimization

**Requirements:** `OUT-003`.

**Files:**
- Create: `src/server/adapters/outline/{search,documents}.ts`
- Create: `src/server/modules/federated-search/{contract,search}.ts`
- Create: `src/server/modules/context/outline-reference-provider.ts`
- Create: `src/server/adapters/http/routes/outline-search.ts`
- Create: `src/server/adapters/mcp/outline-tools.ts`
- Create: `src/web/features/outline/search/index.tsx`
- Test: `tests/integration/outline/{search,read,data-minimization}.test.ts`
- Test: `tests/protocol/outline-surface-parity.test.ts`

**Interfaces:**
- Consumes: `OutlineContentPort.search/read`, Foundation Context Recipe budgets, connector epoch/scope,
  server-derived Member or Run/Attempt/Capability actor, source-reference provenance, and bounded
  ephemeral preview schema.
- Produces: `FederatedSearch.search(command: AuthorizedScopedSearch):
  Promise<Result<EphemeralSearchPage<OutlineReference>>>` and `OutlineReferenceProvider.get(command:
  AuthorizedReferenceRead): Promise<Result<EphemeralObserved<OutlineReadResult>>>`.

- [ ] **Step 1: Write reference-first and canary tests**

```ts
test("returns current content without persisting the fetched body", async () => {
  const canary = `outline-read-${crypto.randomUUID()}`;
  fixture.outline.seedDocument({ id: "doc_a", collectionId: "allowed", title: "A", body: canary, revision: "7" });
  const result = await fixture.read("doc_a");
  expect(result.ok && result.value.body).toBe(canary);
  expect(await fixture.scanDurableStores(canary)).toEqual([]);
  expect(await fixture.reference("doc_a")).toEqual(expect.objectContaining({ documentId: "doc_a", observedRevision: "7" }));
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/integration/outline/search.test.ts tests/integration/outline/read.test.ts tests/integration/outline/data-minimization.test.ts`

Expected: FAIL with missing search/reference modules.

- [ ] **Step 3: Implement live fan-out and bounded reference results**

```ts
return success({
  ephemeralResults: providerResults.map(({ id, title, revision, snippet }) => ({
    reference: { kind: "OUTLINE_DOCUMENT", workspaceId, documentId: id },
    safeProjection: { documentId: id, title, sourceRevision: revision },
    preview: budget.takeEphemeral(snippet),
  })),
  partialFailures,
});
```

Search/read commands bind authenticated actor, project, current session or Run Capability, Context
Recipe budget, scope revision and connector epoch. `ScopedSearch` bounds query bytes, provider count,
result count, aggregate snippet bytes and deadline. HTTP uses `Cache-Control: no-store` and browser
code never writes snippets/bodies to local/session storage, IndexedDB, Cache Storage or telemetry;
MCP/CLI captures and Playwright traces/screenshots are scrubbed/disabled for live content. Safe
reference projections exclude snippets and bodies.

- [ ] **Step 4: Record provenance, then discard fetched bodies after response encoding**

```ts
await accessProvenance.record({ actor: safeActorRef, projectId, connectorId, connectorEpoch, reference: safeReferenceOrCorrelationDigest, observedRevision, observedAt, result: "ALLOWED" });
return success({ reference, body: providerDocument.body }); // body is response-only and absent from persistence commands.
```

The bounded provenance repository is an actual Task 1 module/table API, not a fabricated
`ExecutionAuthority` command. Record `ALLOWED|STALE|UNAVAILABLE|FORBIDDEN|REDACTED` without raw query,
snippet/body, provider error, or guessed denied identifier. Refresh current native collection after
retrieval and before response. Guessed/out-of-scope/moved identifiers return the same
`CONTEXT_REFERENCE_UNAVAILABLE` public error and a correlation digest only.

- [ ] **Step 5: Run GREEN and HTTP/MCP parity**

Run: `bun test tests/integration/outline/{search,read,data-minimization}.test.ts tests/protocol/outline-surface-parity.test.ts`

Expected: PASS; allowed content is returned live, denied references are absent, and canary scans are empty.

- [ ] **Step 6: Commit**

```bash
git add src/server/adapters/outline/search.ts src/server/adapters/outline/documents.ts src/server/modules/federated-search src/server/modules/context/outline-reference-provider.ts src/server/adapters/http/routes/outline-search.ts src/server/adapters/mcp/outline-tools.ts src/web/features/outline/search tests/integration/outline/search.test.ts tests/integration/outline/read.test.ts tests/integration/outline/data-minimization.test.ts tests/protocol/outline-surface-parity.test.ts
git commit -m "feat(outline): add reference-first live retrieval"
```

### Task 4: Delegated Human Create/Edit with Exact Revisions

**Requirements:** `OUT-004`.

**Files:**
- Create: `src/server/adapters/outline/{human-editing,revision-cas}.ts`
- Create: `src/server/modules/documents/human-editing.ts`
- Create: `src/server/adapters/http/routes/outline-documents.ts`
- Create: `src/web/features/outline/editor/index.tsx`
- Test: `tests/integration/outline/{human-editing,revision-conflict}.test.ts`
- Test: `tests/e2e/outline-coediting.spec.ts`

**Interfaces:**
- Consumes: authenticated Member plus server-derived current OAuth grant, current Context Read Scope,
  Foundation `ConnectorAuthority`, and `OutlineContentPort.mutate`.
- Produces: `createDocumentAsMember` and `editDocumentAsMember`, both returning confirmed
  `Observed<OutlineDocumentProjection>`.

- [ ] **Step 1: Write two-writer and create-attribution tests**

```ts
test("stale member save preserves the authored patch and current reference", async () => {
  const a = await fixture.readAs("mem_a", "doc_a");
  const b = await fixture.readAs("mem_b", "doc_a");
  await fixture.editAs("mem_a", patch("first"), a.revision);
  const stale = await fixture.editAs("mem_b", patch("second"), b.revision);
  expect(stale.ok).toBe(false);
  if (stale.ok) throw new Error("expected stale source revision");
  expect(stale.error.code).toBe("SOURCE_REVISION_STALE");
  expect(stale.error.details).toEqual(expect.objectContaining({ authoredPatchDigest: patch("second").digest, currentRevision: "2" }));
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/integration/outline/human-editing.test.ts tests/integration/outline/revision-conflict.test.ts`

Expected: FAIL because human editing is missing.

- [ ] **Step 3: Implement member-only provider-first writes**

```ts
export async function editDocumentAsMember(command: EditDocumentAsMember): Promise<Result<Observed<OutlineDocumentProjection>>> {
  const prepared = await connectorAuthority.prepareOperation(toMemberExactRevisionOperation(command));
  if (!prepared.ok) return prepared;
  const observed = await outline.mutate(prepared.value.authorization, prepared.value.command);
  if (!observed.ok) return recordVisibleProviderFailure(prepared.value.intentId, observed.error);
  return connectorAuthority.confirmMutation(toSafeOutlineConfirmation(prepared.value.intentId, observed.value));
}
```

- [ ] **Step 4: Implement direct creation and residual-race reporting**

```ts
const prepared = await connectorAuthority.prepareOperation(toMemberCreateOperation({ collectionId, title, body, precondition: { kind: "ABSENT" } }));
const created = prepared.ok ? await outline.mutate(prepared.value.authorization, prepared.value.command) : prepared;
return created.ok ? recordConfirmedReference(created.value) : recordVisibleProviderFailure(created.error);
```

Member OAuth identity/grant revision is derived during `prepareOperation` from the authenticated
Member and bound into the authorization digest; request payloads cannot select it. Re-read current
native collection/revision immediately before write and read-confirm afterward. Lost-response recovery
uses the Foundation operation intent and exact provider object/action marker, never body matching.

- [ ] **Step 5: Run GREEN and two-browser co-edit proof**

Run: `bun test tests/integration/outline/{human-editing,revision-conflict}.test.ts && bun run test:e2e:run outline-coediting.spec.ts`

Expected: PASS; member attribution is native and stale saves never overwrite. Task 4 preserves the
bounded authored patch/digest in its typed stale result; `OUT-004` remains `IN_PROGRESS` until Task 6
persists the corresponding immutable proposal/conflict record.

- [ ] **Step 6: Commit**

```bash
git add src/server/adapters/outline/human-editing.ts src/server/adapters/outline/revision-cas.ts src/server/modules/documents/human-editing.ts src/server/adapters/http/routes/outline-documents.ts src/web/features/outline/editor tests/integration/outline/human-editing.test.ts tests/integration/outline/revision-conflict.test.ts tests/e2e/outline-coediting.spec.ts
git commit -m "feat(outline): add exact member coediting"
```

### Task 5: Exact Write Grants and Additional-Document Requests

**Requirements:** `OUT-005`.

**Files:**
- Create: `src/server/db/migrations/0010_outline_grants.sql`
- Create: `src/server/db/migrations/0010_outline_grants.verify.ts`
- Modify: `src/server/db/migrate.ts`
- Create: `src/shared/contracts/document-grants.ts`
- Create: `src/server/modules/documents/{write-grants,additional-document-requests,agent-operations}.ts`
- Create: `src/server/adapters/mcp/document-tools.ts`
- Test: `tests/unit/documents/write-grants.test.ts`
- Test: `tests/integration/outline/agent-grants.test.ts`
- Test: `tests/drills/backup-restore.test.ts`

**Interfaces:**
- Consumes: current Member/run/attempt/connector authority, one-time private `ExecutionAuthority`
  operation proof, exact document revision/digest, current native collection, grantor identity and bot
  identity.
- Produces: `createDocumentWriteGrant`, `requestAdditionalDocument`, `decideAdditionalDocumentRequest`, and `editDocumentAsAgent`.

- [ ] **Step 1: Write property tests across every grant dimension**

```ts
test.each([
  ["another run", { runId: "run_b" }, "DOCUMENT_GRANT_RUN_MISMATCH"],
  ["another document", { documentId: "doc_b" }, "DOCUMENT_GRANT_SCOPE_DENIED"],
  ["expired", { now: "2026-07-12T00:00:00Z" }, "DOCUMENT_GRANT_EXPIRED"],
  ["epoch moved", { connectorEpoch: 8 }, "CONNECTOR_REVOKED"],
] as const)("rejects %s", async (_name, override, code) => {
  const denied = await fixture.authorize(override);
  expect(denied.ok).toBe(false);
  if (denied.ok) throw new Error("expected grant denial");
  expect(denied.error.code).toBe(code);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/unit/documents/write-grants.test.ts tests/integration/outline/agent-grants.test.ts`

Expected: FAIL with missing grant contracts/migration.

- [ ] **Step 3: Add exact grant/request tables**

```sql
CREATE TABLE document_write_grants (
  grant_id TEXT PRIMARY KEY CHECK(length(grant_id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES outline_connections(connector_id),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  grantor_member_id TEXT NOT NULL REFERENCES members(id),
  connector_epoch INTEGER NOT NULL CHECK(connector_epoch > 0),
  grant_revision INTEGER NOT NULL CHECK(grant_revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  revoked_at INTEGER CHECK(revoked_at >= created_at),
  revocation_cause TEXT CHECK(revocation_cause IS NULL OR revocation_cause IN ('MEMBER','RUN','CONNECTOR','SCOPE','RESTORE','EXPLICIT'))
) STRICT;
CREATE TABLE document_write_grant_documents (
  grant_id TEXT NOT NULL REFERENCES document_write_grants(grant_id),
  document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 128),
  source_revision TEXT NOT NULL CHECK(length(source_revision) BETWEEN 1 AND 256),
  comparable_digest TEXT NOT NULL CHECK(length(comparable_digest) = 64 AND comparable_digest NOT GLOB '*[^a-f0-9]*'),
  document_revision INTEGER NOT NULL CHECK(document_revision > 0),
  PRIMARY KEY(grant_id, document_id)
) STRICT;
CREATE TABLE document_write_grant_operations (
  grant_id TEXT NOT NULL REFERENCES document_write_grants(grant_id),
  operation TEXT NOT NULL CHECK(operation = 'EDIT_CONTENT'),
  PRIMARY KEY(grant_id, operation)
) STRICT;
CREATE TABLE additional_document_requests (
  request_id TEXT PRIMARY KEY CHECK(length(request_id) BETWEEN 1 AND 128),
  grant_id TEXT NOT NULL REFERENCES document_write_grants(grant_id),
  document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 128),
  requested_by_run_id TEXT NOT NULL REFERENCES agent_runs(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  request_revision INTEGER NOT NULL CHECK(request_revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  decided_by_member_id TEXT REFERENCES members(id),
  decided_at INTEGER CHECK(decided_at >= created_at),
  CHECK((status = 'PENDING' AND decided_by_member_id IS NULL AND decided_at IS NULL) OR (status IN ('APPROVED','REJECTED') AND decided_by_member_id IS NOT NULL AND decided_at IS NOT NULL))
) STRICT;
```

No grant uses JSON membership/operation columns. Each document is bound to its current source revision/
digest; the cursor advances only after a confirmed edit or an explicit fresh-authoring read. Additional
approval CASes both request and grant revisions and rechecks current scope/native collection/bot
permission/run activity/source revision. Requests confer no authority. Grant expiry/revoke advances
the grant revision and invalidates matching reserved connector operations without bumping the whole
connector epoch.

- [ ] **Step 4: Implement non-authorizing request and explicit grant extension**

```ts
export async function decideAdditionalDocumentRequest(command: DecideAdditionalDocumentRequest): Promise<Result<DocumentWriteGrant>> {
  const request = await loadPendingRequest(command.requestId);
  if (command.decision === "REJECTED") return rejectRequest(request, command.memberId);
  await assertMemberMayGrant(command.memberId, request.documentId);
  return extendGrantExact(request, command.expectedRequestRevision, command.expectedGrantRevision);
}
```

- [ ] **Step 5: Authorize immediately before each bot write**

```ts
const proof = await authority.execute({ kind: "AUTHORIZE_OPERATION", sessionId, sessionFence, operation: exactOutlineGrantOperation });
if (!proof.ok) return proof;
return connectorAuthority.mutateAsAttempt({ actor, privateOperationProof: proof.value, grantId, grantRevision, command: exactMutation }, outlineContent);
```

The one-time operation proof is server-internal, never browser/MCP-visible or stored in idempotency
results. Immediately before provider use, ConnectorAuthority revalidates connector epoch, bot/OAuth
credential, actual native collection, grant ID/revision/grantor/expiry, active run/attempt, exact
document revision/digest and current fence. Revocation racing an issued proof fails this final gate.

- [ ] **Step 6: Run GREEN**

Run: `bun test tests/unit/documents/write-grants.test.ts tests/integration/outline/agent-grants.test.ts src/server/db/migrations/0010_outline_grants.verify.ts tests/drills/backup-restore.test.ts && bun run typecheck`

Expected: PASS; requests confer no authority until an explicit member decision. Verify v9-to-v10,
rollback/history/FKs/integrity, and staged authenticated restore; restore revokes grants/reserved
operations, requires connector/OAuth/bot review, and never resumes old grant work.

- [ ] **Step 7: Commit**

```bash
git add src/server/db/migrations/0010_outline_grants.sql src/server/db/migrations/0010_outline_grants.verify.ts src/server/db/migrate.ts src/server/operations/backup.ts src/server/operations/restore.ts src/shared/contracts/document-grants.ts src/server/modules/documents/write-grants.ts src/server/modules/documents/additional-document-requests.ts src/server/modules/documents/agent-operations.ts src/server/adapters/mcp/document-tools.ts tests/unit/documents/write-grants.test.ts tests/integration/outline/agent-grants.test.ts tests/drills/backup-restore.test.ts
git commit -m "feat(outline): authorize exact agent document grants"
```

### Task 6: Authored Proposals, Conflicts, and Working-Document Dispositions

**Requirements:** `OUT-006`, `OUT-007`.

**Files:**
- Create: `src/server/db/migrations/0011_outline_proposals.sql`
- Create: `src/server/db/migrations/0011_outline_proposals.verify.ts`
- Modify: `src/server/db/migrate.ts`
- Modify: `src/server/operations/{backup,restore}.ts`
- Create: `src/shared/contracts/document-proposals.ts`
- Create: `src/server/modules/documents/{proposals,conflicts,working-documents}.ts`
- Create: `src/web/features/outline/{proposals,working-documents}/index.tsx`
- Test: `tests/unit/documents/proposals.test.ts`
- Test: `tests/integration/outline/{proposal-conflict,working-document}.test.ts`
- Test: `tests/e2e/outline-proposals.spec.ts`
- Test: `tests/drills/backup-restore.test.ts`

**Interfaces:**
- Consumes: exact source reference/revision, bounded `AuthoredDocumentPatch`, current
  member/grant/connector authority, and `OutlineContentPort.read/mutate`.
- Produces: immutable `DocumentProposal`, `DocumentConflict`, and disposition `KEEP|PROMOTE|ARCHIVE`.

- [ ] **Step 1: Write external-change and no-body-persistence tests**

```ts
test("stores references and authored patch but no fetched base/current body", async () => {
  const proposal = await fixture.propose("doc_a", "7", patch("agent change"));
  fixture.outline.changeExternally("doc_a", "external body");
  const result = await fixture.apply(proposal.id);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected conflict proposal");
  expect(result.error.code).toBe("OUTLINE_CONFLICT");
  expect(await fixture.persistedConflict(proposal.id)).toEqual(expect.objectContaining({ baseRevision: "7", currentRevision: "8", authoredPatch: patch("agent change") }));
  expect(JSON.stringify(await fixture.persistedConflict(proposal.id))).not.toContain("external body");
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/unit/documents/proposals.test.ts tests/integration/outline/proposal-conflict.test.ts tests/integration/outline/working-document.test.ts`

Expected: FAIL with missing proposal migration/module.

- [ ] **Step 3: Add proposal/reference-only tables**

```sql
CREATE TABLE document_proposals (
  proposal_id TEXT PRIMARY KEY CHECK(length(proposal_id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES outline_connections(connector_id),
  connector_epoch INTEGER NOT NULL CHECK(connector_epoch > 0),
  document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id),
  base_revision TEXT NOT NULL CHECK(length(base_revision) BETWEEN 1 AND 256),
  base_digest TEXT NOT NULL CHECK(length(base_digest) = 64 AND base_digest NOT GLOB '*[^a-f0-9]*'),
  authored_patch TEXT NOT NULL CHECK(length(CAST(authored_patch AS BLOB)) BETWEEN 1 AND 131072),
  authored_patch_digest TEXT NOT NULL CHECK(length(authored_patch_digest) = 64 AND authored_patch_digest NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE TABLE document_proposal_decisions (
  decision_id TEXT PRIMARY KEY CHECK(length(decision_id) BETWEEN 1 AND 128),
  proposal_id TEXT NOT NULL REFERENCES document_proposals(proposal_id),
  decision_revision INTEGER NOT NULL CHECK(decision_revision > 0),
  decision TEXT NOT NULL CHECK(decision IN ('APPLY','REJECT','CONFLICT')),
  member_id TEXT REFERENCES members(id),
  provider_revision TEXT CHECK(provider_revision IS NULL OR length(provider_revision) BETWEEN 1 AND 256),
  decided_at INTEGER NOT NULL CHECK(decided_at >= 0),
  UNIQUE(proposal_id, decision_revision)
) STRICT;
CREATE TABLE document_conflicts (
  conflict_id TEXT PRIMARY KEY CHECK(length(conflict_id) BETWEEN 1 AND 128),
  proposal_id TEXT NOT NULL REFERENCES document_proposals(proposal_id),
  current_revision TEXT NOT NULL CHECK(length(current_revision) BETWEEN 1 AND 256),
  current_digest TEXT NOT NULL CHECK(length(current_digest) = 64 AND current_digest NOT GLOB '*[^a-f0-9]*'),
  detected_at INTEGER NOT NULL CHECK(detected_at >= 0),
  UNIQUE(proposal_id, current_revision, current_digest)
) STRICT;
CREATE TABLE external_working_documents (
  working_document_id TEXT PRIMARY KEY CHECK(length(working_document_id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES outline_connections(connector_id),
  connector_epoch INTEGER NOT NULL CHECK(connector_epoch > 0),
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id),
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id),
  document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 128),
  current_revision TEXT NOT NULL CHECK(length(current_revision) BETWEEN 1 AND 256),
  current_digest TEXT NOT NULL CHECK(length(current_digest) = 64 AND current_digest NOT GLOB '*[^a-f0-9]*'),
  enable_approval_id TEXT NOT NULL CHECK(length(enable_approval_id) BETWEEN 1 AND 128),
  lifecycle_revision INTEGER NOT NULL CHECK(lifecycle_revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE TABLE working_document_dispositions (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  working_document_id TEXT NOT NULL REFERENCES external_working_documents(working_document_id),
  expected_lifecycle_revision INTEGER NOT NULL CHECK(expected_lifecycle_revision > 0),
  disposition TEXT NOT NULL CHECK(disposition IN ('KEEP','PROMOTE','ARCHIVE')),
  actor_member_id TEXT NOT NULL REFERENCES members(id),
  resulting_revision TEXT CHECK(resulting_revision IS NULL OR length(resulting_revision) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(working_document_id, expected_lifecycle_revision)
) STRICT;
```

- [ ] **Step 4: Implement conflict creation from current revision only**

```ts
const current = await outline.read(currentScope, reference);
if (!current.ok) return current;
if (current.value.sourceRevision !== proposal.baseRevision || current.value.comparableDigest !== proposal.baseDigest) {
  return appendConflict({ proposalId, currentRevision: current.value.sourceRevision, currentDigest: current.value.comparableDigest }); // body is not passed.
}
return applyProposalAsAuthenticatedMember({ proposal, authoredPatch: proposal.authoredPatch, decisionRevision });
```

Proposal content is immutable and decisions/conflicts are append-only. Active Member OAuth identity is
derived server-side; read scope and current native collection are revalidated before apply, the
provider mutation includes the bounded authored patch, and concurrent decisions CAS one decision
revision. Base/current fetched bodies never persist.

- [ ] **Step 5: Implement explicit dispositions**

```ts
switch (command.disposition) {
  case "KEEP": return recordDisposition(command, "KEEP");
  case "PROMOTE": return authorizeThenMutate(command, { kind: "PROMOTE_WORKING_DOCUMENT", targetCollectionId: command.targetCollectionId, title: command.title });
  case "ARCHIVE": return authorizeThenMutate(command, { kind: "ARCHIVE_WORKING_DOCUMENT" });
}
```

Working-document creation is explicitly enabled and approval-provenanced. If an agent creates it, a
separate approval-gated bot-create mutation is required; an edit grant never confers create authority.
Existence or run completion never implies promotion. `KEEP` preserves its working-material
classification; Promote/Archive are separate member-authorized connector operations with current
scope/revision and lifecycle CAS.

- [ ] **Step 6: Run GREEN and browser proof**

Run: `bun test tests/unit/documents/proposals.test.ts tests/integration/outline/{proposal-conflict,working-document}.test.ts src/server/db/migrations/0011_outline_proposals.verify.ts tests/drills/backup-restore.test.ts && bun run test:e2e:run outline-proposals.spec.ts`

Expected: PASS; no-action disposition is `KEEP`, and Promote/Archive require separate authorization.
Verify v10-to-v11 and older supported backup restore through v11; bounded immutable proposals/history
survive, while restore never auto-applies a proposal or resumes a working-document mutation.

- [ ] **Step 7: Commit**

```bash
git add src/server/db/migrations/0011_outline_proposals.sql src/server/db/migrations/0011_outline_proposals.verify.ts src/server/db/migrate.ts src/server/operations/backup.ts src/server/operations/restore.ts src/shared/contracts/document-proposals.ts src/server/modules/documents/proposals.ts src/server/modules/documents/conflicts.ts src/server/modules/documents/working-documents.ts src/web/features/outline/proposals src/web/features/outline/working-documents tests/unit/documents/proposals.test.ts tests/integration/outline/proposal-conflict.test.ts tests/integration/outline/working-document.test.ts tests/drills/backup-restore.test.ts tests/e2e/outline-proposals.spec.ts
git commit -m "feat(outline): preserve authored conflict proposals"
```

### Task 7: Revocation and Cross-Store Canary Drill

**Requirements:** `OUT-008`, `OUT-009`.

**Files:**
- Create: `src/server/modules/documents/revocation.ts`
- Create: `tests/drills/{outline-revocation,outline-data-canary,outline-conflict}.test.ts`
- Modify: `src/server/adapters/http/routes/connectors-outline.ts`
- Test: `tests/integration/outline/revocation.test.ts`

**Interfaces:**
- Consumes: Foundation `APPLY_REVOCATION`, connector/Member epochs, credential revocation, queued-operation invalidation, and backup inspection helpers.
- Produces: distinct revocation causes for delegated member, bot connection, connector scope, Document Write Grant, member offboarding, and restore.

- [ ] **Step 1: Write every revocation-race test**

```ts
test.each(["MEMBER_GRANT", "BOT_CONNECTION", "CONNECTOR_SCOPE", "DOCUMENT_GRANT", "MEMBER_OFFBOARDING", "RESTORE"] as const)(
  "denies a write after %s revocation", async (cause) => {
    const pending = await fixture.authorizeBotWrite();
    await fixture.revoke(cause);
    const denied = await fixture.commitBotWrite(pending);
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("expected revoked operation");
    expect(denied.error.code).toBe(expectedRevocationCode(cause));
    expect(await fixture.providerWriteCount()).toBe(0);
  },
);
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/integration/outline/revocation.test.ts tests/drills/outline-revocation.test.ts`

Expected: FAIL with missing document revocation implementation.

- [ ] **Step 3: Implement epoch-first invalidation and typed disposition**

```ts
export async function revokeOutlineAuthority(command: RevokeOutlineAuthority): Promise<Result<OutlineRevocation>> {
  const committed = transaction.immediate(() => {
    const revision = command.cause === "DOCUMENT_GRANT"
      ? revokeExactGrantAndReservedOperations(command)
      : revokeAuthorityAndAdvanceRequiredEpoch(command);
    const intentId = persistOutlineRevocationIntent(command, revision);
    return { revision, intentId, activeWork: deriveCommittedDisposition(command) };
  });
  await revocationDispatcher.deliver(committed.intentId);
  return success({ cause: command.cause, connectorEpoch: committed.revision.connectorEpoch, activeWork: committed.activeWork });
}
```

The immediate transaction performs only local synchronous writes: credential/grant/scope/epoch
invalidation, queued-write holds, affected-work dispositions, safe audit and durable delivery intent.
`APPLY_REVOCATION` and best-effort provider token revoke happen after commit and resume at startup.
Document-grant revoke advances only that grant and invalidates matching reserved operations; broader
member/bot/connector/scope/offboarding/restore causes advance the appropriate epoch. Provider failure
never restores authority. Race tests cover search/read, human/bot write, proposal apply, working
document, lost response, active run and `WAITING` versus proposal-only disposition.

- [ ] **Step 4: Add one canary across all prohibited stores**

```ts
const canaries = generateOutlineCanaries();
await exerciseEveryOutlinePath(canaries);
const stores = await inspectEveryExpectedOutlineStore();
expect(stores.map((store) => store.id).sort()).toEqual(EXPECTED_OUTLINE_STORE_IDS);
for (const store of stores) for (const encoded of forbiddenCanaryEncodings(canaries.forbidden)) expect(store.bytes.includes(encoded)).toBe(false);
expect(await authoredProposalPatch()).toContain(canaries.allowedAuthoredPatch);
```

Use distinct forbidden canaries for fetched/denied/base/current bodies, snippets, raw queries,
access/refresh tokens, PKCE/state/code material and provider errors, plus one allowed deliberate
authored-patch canary. Extend the Foundation closed inventory to every Outline/projection/intent/
idempotency/audit/outbox table, SQLite/WAL/SHM, logs/temp/staging, encrypted backup plus independently
restored logical data, runner/CLI/MCP/browser caches/network captures/Playwright artifacts/container
volumes/evidence/manifests. Search raw/JSON/URL/base64; missing, unreadable, skipped or unexpected
stores fail.

- [ ] **Step 5: Run GREEN**

Run: `bun test tests/integration/outline/revocation.test.ts tests/drills/outline-revocation.test.ts tests/drills/outline-data-canary.test.ts tests/drills/outline-conflict.test.ts`

Expected: PASS; no stale operation reaches the strict provider and every prohibited store is canary-free.

- [ ] **Step 6: Commit**

```bash
git add src/server/modules/documents/revocation.ts src/server/adapters/http/routes/connectors-outline.ts tests/integration/outline/revocation.test.ts tests/drills/outline-revocation.test.ts tests/drills/outline-data-canary.test.ts tests/drills/outline-conflict.test.ts
git commit -m "feat(outline): revoke document authority safely"
```

### Task 8: Two-Member Journey, Live Ledger, and Phase Gate

**Requirements:** `OUT-010` and final live evidence for `OUT-001` through `OUT-009`.

**Files:**
- Create: `tests/e2e/outline-dogfood.spec.ts`
- Create: `tests/e2e/outline-live-dogfood.spec.ts`
- Create: `tests/evidence/outline-matrix.ts`
- Create: `tests/unit/evidence/outline-matrix.test.ts`
- Create: `scripts/outline-evidence.ts`
- Create: `docs/evidence/outline/EVIDENCE-TEMPLATE.md`
- Create: `docs/evidence/outline/<build-id>.md`
- Create: `docs/evidence/outline/LIVE-DOGFOOD-LEDGER.md`
- Modify: `src/web/app.tsx`
- Modify: `package.json`
- Modify: `MANIFEST.md`
- Modify: `MANIFEST.sha256`

**Interfaces:**
- Consumes: all Outline contracts, strict adapter fault controls, authorized disposable-workspace configuration, and acceptance evidence schema.
- Produces: one fixture-backed two-member journey, strict `OUT-001`–`OUT-010` proof registry,
  build-specific local record, and machine-validated append-only live ledger.

- [ ] **Step 1: Write the complete fixture-backed journey**

```ts
test("two members and one granted agent collaborate without authority drift", async ({ browser }) => {
  const memberA = await browser.newPage(); const memberB = await browser.newPage();
  await createDocumentAs(memberA, "shared"); await editDocumentAs(memberB, "member edit");
  const grant = await grantAgent(memberA, ["doc_shared"]);
  await agentEdit(grant, "agent edit"); await externalEdit("doc_shared", "external edit");
  await expect(agentEdit(grant, "stale edit")).resolves.toEqual(expect.objectContaining({ code: "OUTLINE_CONFLICT" }));
  await revokeGrant(grant); await expect(agentEdit(grant, "denied")).resolves.toEqual(expect.objectContaining({ code: "DOCUMENT_GRANT_REVOKED" }));
});
```

- [ ] **Step 2: Run RED**

Run: `bun run test:e2e:run outline-dogfood.spec.ts`

Expected: FAIL until all routes, UI composition, and collaboration commands are wired.

- [ ] **Step 3: Create exact evidence templates**

```markdown
| Requirement | Build | Git revision | Outline workspace/document revision | Collab run/grant/proposal/audit IDs | Journey/command | Result | Reviewer | Blocker |
|---|---|---|---|---|---|---|---|---|
```

The neutral template is `NOT_RUN`; the separate build record includes tested commit/dirty state and
artifact/manifest/image identities. `outline-evidence` validates exact local/live test names, parses
Playwright JSON, and derives `NOT_STARTED|LOCAL_PROOF_COMPLETE|IN_PROGRESS_LIVE|BLOCKED_ENV|PASS|FAIL`.
Skipped, unreviewed, fixture-only, build-mismatched or blocked evidence cannot pass. Live execution
requires approved disposable workspace ID plus approval ID and refuses unknown/production-looking
targets. Evidence contains safe IDs/revisions only, no bodies/snippets/tokens/queries/provider URLs.

- [ ] **Step 4: Run the local Outline gate GREEN**

Run: `bun test tests/unit/outline tests/unit/documents tests/integration/outline tests/protocol/outline-surface-parity.test.ts tests/drills/outline-*.test.ts && bun run test:e2e:run outline-connection.spec.ts outline-coediting.spec.ts outline-proposals.spec.ts outline-dogfood.spec.ts`

Expected: PASS and exit 0; live-only rows remain `IN_PROGRESS` or `BLOCKED`.

- [ ] **Step 5: Execute authorized disposable live evidence**

Run only with explicit disposable-target approval: `COLLAB_LIVE_OUTLINE=1 bun run test:e2e:run outline-live-dogfood.spec.ts --reporter=json` then `bun run outline:evidence validate-live <playwright-json>`.

Expected: PASS only with approved disposable workspace and a human-reviewed result. Live cases verify
native Member A/Member B/bot actors from Outline history, out-of-scope invisibility, repeated exact-
grant edits, additional-document request, external conflict, optional working document/dispositions,
grant/member/bot/scope revocation, and post-live local-store/backup/restore scan. Otherwise record
`BLOCKED_ENV`; a skip is never PASS.

- [ ] **Step 6: Run the full package gate**

Run every AGENTS command separately and record each result. Use
`tests/scripts/compose-config-with-temporary-secrets.sh`, never `.env.example` for secrets. Also run
`archive:verify`, Outline evidence validation, compiled CLI smoke, packaged server readiness/shutdown,
hardened container readiness, authenticated backup/verify, isolated restore, placeholder scan, and
`git diff --check`. After final source/evidence inventory, run `manifest:generate`, then
`manifest:verify` and `archive:verify`, preserving tested-build versus later evidence-commit identity.

Expected: every locally achievable command exits 0 and is recorded independently; live/environment
failures remain separate and unrun checks do not inherit success.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/outline-dogfood.spec.ts tests/e2e/outline-live-dogfood.spec.ts tests/evidence/outline-matrix.ts tests/unit/evidence/outline-matrix.test.ts scripts/outline-evidence.ts docs/evidence/outline src/web/app.tsx package.json MANIFEST.md MANIFEST.sha256
git commit -m "test(outline): record bidirectional collaboration evidence"
```
