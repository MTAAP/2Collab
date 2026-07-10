# Outline Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `OUT-001` through `OUT-010` so two members and authorized Agent Runs collaborate bidirectionally through Outline with native attribution, exact grants/revisions, safe conflict proposals, revocation, and source-body minimization.

**Architecture:** A narrow `OutlinePort` is the true-external seam, with a production adapter and strict stateful fixture adapter. Delegated member OAuth performs direct human creation/edits; one team bot identity performs agent reads, proposals, and exact-grant writes. All paths consume Foundation credential encryption, connector epochs/scopes, exact-revision operation authorization, audit, reconciliation, Context Recipe, source-reference, and `ExecutionAuthority` primitives.

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
- `src/server/db/migrations/0201_outline.sql`: bot connection, delegated OAuth metadata, Context Read Scopes, document references, and access provenance.
- `src/server/db/migrations/0202_outline_grants.sql`: exact write grants and additional-document requests.
- `src/server/db/migrations/0203_outline_proposals.sql`: proposals, conflicts, and working-document references/dispositions without fetched bodies.
- `src/server/adapters/outline/contract.ts`: narrow `OutlinePort` interface.
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
- Create: `src/server/adapters/outline/contract.ts`
- Create: `src/server/db/migrations/0201_outline.sql`
- Create: `src/server/db/migrations/0201_outline.verify.ts`
- Test: `tests/unit/outline/contracts.test.ts`
- Test: `tests/integration/outline/migration-0201.test.ts`

**Interfaces:**
- Consumes: Foundation `Result<T>`, `Observed<T>`, `ExactRevisionMutation<T>`, `ScopedSearch`, `ContextReference`, and `ContextConnector<TReference,TDocument,TMutation>`.
- Produces:

```ts
export interface OutlinePort
  extends ContextConnector<OutlineReference, OutlineDocument, OutlineMutation> {
  exchangeMemberGrant(command: ExchangeOutlineOAuthGrant): Promise<Result<DelegatedOutlineGrant>>;
  revokeMemberGrant(command: RevokeOutlineOAuthGrant): Promise<Result<GrantRevocation>>;
  inspectBotConnection(query: InspectOutlineBot): Promise<Result<OutlineBotConnection>>;
}

export type OutlineMutation =
  | { kind: "CREATE_DOCUMENT_AS_MEMBER"; identity: DelegatedMemberIdentityRef; collectionId: string; title: string; body: string }
  | { kind: "EDIT_DOCUMENT_AS_MEMBER"; identity: DelegatedMemberIdentityRef; documentId: string; expectedRevision: string; authoredPatch: AuthoredDocumentPatch }
  | { kind: "EDIT_DOCUMENT_AS_BOT"; runId: AgentRunId; grantId: DocumentWriteGrantId; documentId: string; expectedRevision: string; authoredPatch: AuthoredDocumentPatch }
  | { kind: "APPLY_PROPOSAL_AS_MEMBER"; identity: DelegatedMemberIdentityRef; proposalId: DocumentProposalId; documentId: string; expectedRevision: string }
  | { kind: "PROMOTE_WORKING_DOCUMENT"; identity: DelegatedMemberIdentityRef; workingDocumentId: WorkingDocumentId; expectedRevision: string; targetCollectionId: string; title: string }
  | { kind: "ARCHIVE_WORKING_DOCUMENT"; identity: DelegatedMemberIdentityRef; workingDocumentId: WorkingDocumentId; expectedRevision: string };
```

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
  connector_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE,
  bot_credential_id TEXT NOT NULL,
  connector_epoch INTEGER NOT NULL CHECK (connector_epoch > 0),
  revision INTEGER NOT NULL CHECK (revision > 0)
);
CREATE TABLE outline_member_grants (
  connector_id TEXT NOT NULL REFERENCES outline_connections(connector_id),
  member_id TEXT NOT NULL,
  outline_user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  grant_revision INTEGER NOT NULL CHECK (grant_revision > 0),
  revoked_at TEXT,
  PRIMARY KEY (connector_id, member_id)
);
CREATE TABLE outline_context_read_scopes (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL REFERENCES outline_connections(connector_id),
  collection_id TEXT NOT NULL,
  scope_revision INTEGER NOT NULL CHECK (scope_revision > 0),
  PRIMARY KEY (project_id, connector_id, collection_id)
);
CREATE TABLE outline_document_references (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  observed_revision TEXT NOT NULL,
  safe_title TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, connector_id, document_id)
);
```

- [ ] **Step 4: Implement the closed schemas and `OutlinePort` exactly as shown**

```ts
export const AuthoredDocumentPatchSchema = z.object({
  format: z.literal("UNIFIED_TEXT_PATCH_V1"),
  value: z.string().min(1).max(131_072),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
```

- [ ] **Step 5: Run GREEN**

Run: `bun test tests/unit/outline/contracts.test.ts tests/integration/outline/migration-0201.test.ts && bun run typecheck`

Expected: PASS and exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/shared/contracts/outline.ts src/server/adapters/outline/contract.ts src/server/db/migrations/0201_outline.sql src/server/db/migrations/0201_outline.verify.ts tests/unit/outline/contracts.test.ts tests/integration/outline/migration-0201.test.ts
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
- Produces: `beginOutlineOAuth`, `finishOutlineOAuth`, `resolveOutlineIdentity`, `assertOutlineScope`, and `StrictOutlineAdapter implements OutlinePort`.

- [ ] **Step 1: Write OAuth, attribution, and denied-collection tests**

```ts
test("keeps delegated member and bot authority distinct", async () => {
  const outline = StrictOutlineAdapter.seed({ allowedCollections: ["allowed"], deniedCollections: ["denied"] });
  await outline.mutate(memberEdit({ memberId: "mem_a", documentId: "doc_a" }));
  await outline.mutate(botEdit({ runId: "run_a", documentId: "doc_a" }));
  expect(outline.calls.map((call) => call.actor)).toEqual(["OUTLINE_MEMBER:mem_a", "OUTLINE_BOT:run_a"]);
  const denied = await outline.read({ documentId: "doc_denied", collectionId: "denied" });
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
  if (request.operation === "HUMAN_WRITE" && !request.memberGrant) return failure("OUTLINE_MEMBER_GRANT_REQUIRED", "EXPLICIT_RESUME");
  if (request.operation === "AGENT_OPERATION" && !request.runId) return failure("RUN_AUTHORITY_REQUIRED", "NEVER");
  return success(request.operation === "HUMAN_WRITE"
    ? { kind: "MEMBER", memberId: request.memberId, grantRevision: request.memberGrant!.revision }
    : { kind: "BOT", runId: request.runId! });
}
```

- [ ] **Step 4: Implement the stateful strict adapter with revision and fault controls**

```ts
export class StrictOutlineAdapter implements OutlinePort {
  readonly calls: OutlineCall[] = [];
  private readonly documents = new Map<string, FixtureDocument>();
  private nextFault: OutlineFixtureFault | undefined;
  changeExternally(documentId: string, body: string): void { this.replace(documentId, body, "EXTERNAL_MEMBER"); }
  failNext(fault: OutlineFixtureFault): void { this.nextFault = fault; }
  async search(query: ScopedSearch): Promise<Result<readonly ContextReference[]>> {
    return searchFixtureDocuments(this.documents, this.calls, query);
  }
  async read(reference: OutlineReference): Promise<Result<Observed<OutlineDocument>>> {
    return readFixtureDocument(this.documents, this.calls, reference);
  }
  async mutate(command: ExactRevisionMutation<OutlineMutation>): Promise<Result<Observed<OutlineDocument>>> {
    return mutateFixtureDocument(this.documents, this.calls, command, this.consumeFault());
  }
  async exchangeMemberGrant(command: ExchangeOutlineOAuthGrant): Promise<Result<DelegatedOutlineGrant>> {
    return exchangeFixtureGrant(this.calls, command);
  }
  async revokeMemberGrant(command: RevokeOutlineOAuthGrant): Promise<Result<GrantRevocation>> {
    return revokeFixtureGrant(this.calls, command);
  }
  async inspectBotConnection(query: InspectOutlineBot): Promise<Result<OutlineBotConnection>> {
    return inspectFixtureBot(this.calls, query);
  }
}
```

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
- Consumes: `OutlinePort.search/read`, Foundation Context Recipe budgets, connector epoch/scope, source-reference provenance, and bounded preview schema.
- Produces: `FederatedSearch.search(query): Promise<Result<FederatedSearchResult>>` and `OutlineReferenceProvider.get(reference): Promise<Result<Observed<OutlineReadResult>>>`.

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
  references: providerResults.map(({ id, collectionId, title, updatedAt, revision, snippet }) => ({
    kind: "OUTLINE_DOCUMENT", documentId: id, collectionId, title, updatedAt, observedRevision: revision,
    preview: budget.take(snippet),
  })),
  partialFailures,
});
```

- [ ] **Step 4: Record provenance, then discard fetched bodies after response encoding**

```ts
await authority.execute({ kind: "RECORD_SOURCE_ACCESS", reference, observedRevision, observedAt, result: "ALLOWED" });
return success({ reference, body: providerDocument.body }); // body is response-only and absent from persistence commands.
```

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
- Consumes: delegated member identity, current Context Read Scope, `ExecutionAuthority.execute({ kind: "AUTHORIZE_OPERATION", ... })`, and `OutlinePort.mutate`.
- Produces: `createDocumentAsMember` and `editDocumentAsMember`, both returning confirmed `Observed<OutlineDocumentReference>`.

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
export async function editDocumentAsMember(command: EditDocumentAsMember): Promise<Result<Observed<OutlineDocumentReference>>> {
  const identity = resolveOutlineIdentity({ operation: "HUMAN_WRITE", memberId: command.memberId, memberGrant: command.grant });
  if (!identity.ok) return identity;
  const authorization = await authority.execute(toOutlineAuthorization(command));
  if (!authorization.ok) return authorization;
  return outline.mutate({ mutation: toMemberMutation(command), expectedRevision: command.expectedRevision });
}
```

- [ ] **Step 4: Implement direct creation and residual-race reporting**

```ts
const created = await outline.mutate({ mutation: { kind: "CREATE_DOCUMENT_AS_MEMBER", identity, collectionId, title, body }, expectedRevision: "ABSENT" });
return created.ok ? recordConfirmedReference(created.value) : recordVisibleProviderFailure(created.error);
```

- [ ] **Step 5: Run GREEN and two-browser co-edit proof**

Run: `bun test tests/integration/outline/{human-editing,revision-conflict}.test.ts && bun run test:e2e:run outline-coediting.spec.ts`

Expected: PASS; member attribution is native and stale saves never overwrite.

- [ ] **Step 6: Commit**

```bash
git add src/server/adapters/outline/human-editing.ts src/server/adapters/outline/revision-cas.ts src/server/modules/documents/human-editing.ts src/server/adapters/http/routes/outline-documents.ts src/web/features/outline/editor tests/integration/outline/human-editing.test.ts tests/integration/outline/revision-conflict.test.ts tests/e2e/outline-coediting.spec.ts
git commit -m "feat(outline): add exact member coediting"
```

### Task 5: Exact Write Grants and Additional-Document Requests

**Requirements:** `OUT-005`.

**Files:**
- Create: `src/server/db/migrations/0202_outline_grants.sql`
- Create: `src/server/db/migrations/0202_outline_grants.verify.ts`
- Create: `src/shared/contracts/document-grants.ts`
- Create: `src/server/modules/documents/{write-grants,additional-document-requests,agent-operations}.ts`
- Create: `src/server/adapters/mcp/document-tools.ts`
- Test: `tests/unit/documents/write-grants.test.ts`
- Test: `tests/integration/outline/agent-grants.test.ts`

**Interfaces:**
- Consumes: current Member/run/connector authority, `ExecutionAuthority` operation authorization, exact document revision, and bot identity.
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
  grant_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  document_ids_json TEXT NOT NULL,
  operations_json TEXT NOT NULL,
  connector_epoch INTEGER NOT NULL,
  grant_revision INTEGER NOT NULL CHECK (grant_revision > 0),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE additional_document_requests (
  request_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES document_write_grants(grant_id),
  document_id TEXT NOT NULL,
  requested_by_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  decided_by_member_id TEXT,
  decided_at TEXT
);
```

- [ ] **Step 4: Implement non-authorizing request and explicit grant extension**

```ts
export async function decideAdditionalDocumentRequest(command: DecideAdditionalDocumentRequest): Promise<Result<DocumentWriteGrant>> {
  const request = await loadPendingRequest(command.requestId);
  if (command.decision === "REJECTED") return rejectRequest(request, command.memberId);
  await assertMemberMayGrant(command.memberId, request.documentId);
  return extendGrantExact(request.grantId, request.documentId, command.expectedGrantRevision);
}
```

- [ ] **Step 5: Authorize immediately before each bot write**

```ts
const authorization = await authority.execute({ kind: "AUTHORIZE_OPERATION", sessionId, sessionFence, operation: { kind: "MUTATE_OUTLINE", connectorId, connectorEpoch, documentId, expectedRevision, mutation: "EDIT_CONTENT" } });
if (!authorization.ok) return authorization;
return outline.mutate({ mutation: botEdit, expectedRevision });
```

- [ ] **Step 6: Run GREEN**

Run: `bun test tests/unit/documents/write-grants.test.ts tests/integration/outline/agent-grants.test.ts && bun run typecheck`

Expected: PASS; requests confer no authority until an explicit member decision.

- [ ] **Step 7: Commit**

```bash
git add src/server/db/migrations/0202_outline_grants.sql src/server/db/migrations/0202_outline_grants.verify.ts src/shared/contracts/document-grants.ts src/server/modules/documents/write-grants.ts src/server/modules/documents/additional-document-requests.ts src/server/modules/documents/agent-operations.ts src/server/adapters/mcp/document-tools.ts tests/unit/documents/write-grants.test.ts tests/integration/outline/agent-grants.test.ts
git commit -m "feat(outline): authorize exact agent document grants"
```

### Task 6: Authored Proposals, Conflicts, and Working-Document Dispositions

**Requirements:** `OUT-006`, `OUT-007`.

**Files:**
- Create: `src/server/db/migrations/0203_outline_proposals.sql`
- Create: `src/server/db/migrations/0203_outline_proposals.verify.ts`
- Create: `src/shared/contracts/document-proposals.ts`
- Create: `src/server/modules/documents/{proposals,conflicts,working-documents}.ts`
- Create: `src/web/features/outline/{proposals,working-documents}/index.tsx`
- Test: `tests/unit/documents/proposals.test.ts`
- Test: `tests/integration/outline/{proposal-conflict,working-document}.test.ts`
- Test: `tests/e2e/outline-proposals.spec.ts`

**Interfaces:**
- Consumes: exact source reference/revision, bounded `AuthoredDocumentPatch`, current member/grant/connector authority, and `OutlinePort.read/mutate`.
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
  proposal_id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  base_revision TEXT NOT NULL,
  authored_patch TEXT NOT NULL,
  authored_patch_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPLIED','REJECTED','CONFLICT')),
  current_revision TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE external_working_documents (
  working_document_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  connector_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  observed_revision TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('KEEP','PROMOTE','ARCHIVE')),
  disposition_actor_id TEXT,
  disposition_at TEXT
);
```

- [ ] **Step 4: Implement conflict creation from current revision only**

```ts
const current = await outline.read(reference);
if (!current.ok) return current;
if (current.value.revision !== proposal.baseRevision) {
  return markConflict({ proposalId, currentRevision: current.value.revision }); // current.value.body is not passed.
}
return applyProposalWithMemberIdentity(proposal, decision.identity);
```

- [ ] **Step 5: Implement explicit dispositions**

```ts
switch (command.disposition) {
  case "KEEP": return recordDisposition(command, "KEEP");
  case "PROMOTE": return authorizeThenMutate(command, { kind: "PROMOTE_WORKING_DOCUMENT", targetCollectionId: command.targetCollectionId, title: command.title });
  case "ARCHIVE": return authorizeThenMutate(command, { kind: "ARCHIVE_WORKING_DOCUMENT" });
}
```

- [ ] **Step 6: Run GREEN and browser proof**

Run: `bun test tests/unit/documents/proposals.test.ts tests/integration/outline/{proposal-conflict,working-document}.test.ts && bun run test:e2e:run outline-proposals.spec.ts`

Expected: PASS; no-action disposition is `KEEP`, and Promote/Archive require separate authorization.

- [ ] **Step 7: Commit**

```bash
git add src/server/db/migrations/0203_outline_proposals.sql src/server/db/migrations/0203_outline_proposals.verify.ts src/shared/contracts/document-proposals.ts src/server/modules/documents/proposals.ts src/server/modules/documents/conflicts.ts src/server/modules/documents/working-documents.ts src/web/features/outline/proposals src/web/features/outline/working-documents tests/unit/documents/proposals.test.ts tests/integration/outline/proposal-conflict.test.ts tests/integration/outline/working-document.test.ts tests/e2e/outline-proposals.spec.ts
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
test.each(["MEMBER_GRANT", "BOT_CONNECTION", "CONNECTOR_SCOPE", "DOCUMENT_GRANT", "MEMBER_OFFBOARDING"] as const)(
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
  return transaction.immediate(async () => {
    const epoch = await connectorEpochs.increment(command.connectorId, command.expectedEpoch);
    await invalidateQueuedWrites(command.connectorId, epoch);
    await authority.execute({ kind: "APPLY_REVOCATION", source: toRevocationSource(command, epoch) });
    return success({ cause: command.cause, connectorEpoch: epoch, activeWork: "REDUCED_OR_WAITING" });
  });
}
```

- [ ] **Step 4: Add one canary across all prohibited stores**

```ts
const canary = `outline-canary-${crypto.randomUUID()}`;
await exerciseSearchReadHumanEditGrantProposalConflictDisconnectBackupRestore(canary);
for (const store of await prohibitedStores()) {
  expect(store.bytes.includes(canary), `${store.name} contains source body canary`).toBe(false);
}
```

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
- Create: `docs/evidence/outline/EVIDENCE-TEMPLATE.md`
- Create: `docs/evidence/outline/LIVE-DOGFOOD-LEDGER.md`
- Modify: `src/web/app.tsx`
- Modify: `MANIFEST.md`
- Modify: `MANIFEST.sha256`

**Interfaces:**
- Consumes: all Outline contracts, strict adapter fault controls, authorized disposable-workspace configuration, and acceptance evidence schema.
- Produces: one fixture-backed two-member journey and one append-only live ledger with build, Git revision, Outline workspace/document revision, Collab run/grant/proposal/audit IDs, command/journey, result, reviewer, and blocker.

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

- [ ] **Step 4: Run the local Outline gate GREEN**

Run: `bun test tests/unit/outline tests/unit/documents tests/integration/outline tests/protocol/outline-surface-parity.test.ts tests/drills/outline-*.test.ts && bun run test:e2e:run outline-connection.spec.ts outline-coediting.spec.ts outline-proposals.spec.ts outline-dogfood.spec.ts`

Expected: PASS and exit 0; live-only rows remain `IN_PROGRESS` or `BLOCKED`.

- [ ] **Step 5: Execute authorized disposable live evidence**

Run: `COLLAB_LIVE_OUTLINE=1 bun run test:e2e:run outline-dogfood.spec.ts`

Expected: PASS only with an explicitly approved disposable workspace; otherwise SKIP with `LIVE_OUTLINE_NOT_AUTHORIZED`, recorded as `BLOCKED`, never `PASS`.

- [ ] **Step 6: Run the full package gate**

Run: `bun ci && bun run format:check && bun run lint && bun run typecheck && bun run test && bun run build && bunx playwright install chromium && bun run test:e2e:run && bun run audit:public && bun run manifest:verify && SESSION_SECRET=0123456789abcdef0123456789abcdef PUBLIC_BASE_URL=https://collab.test WEBAUTHN_RP_ID=collab.test DEPLOYMENT_MASTER_KEY_FILE=.env.example BOOTSTRAP_SECRET_FILE=.env.example BACKUP_DIR=/backups docker compose config --quiet && docker build --tag 2collab:verify . && git diff --check`

Expected: every command exits 0.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/outline-dogfood.spec.ts docs/evidence/outline/EVIDENCE-TEMPLATE.md docs/evidence/outline/LIVE-DOGFOOD-LEDGER.md src/web/app.tsx MANIFEST.md MANIFEST.sha256
git commit -m "test(outline): record bidirectional collaboration evidence"
```
