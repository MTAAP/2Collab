# Phase 3: Outline Collaboration Implementation Plan

> **Authority: Derived implementation guidance.** The canonical product authority is the [Product Spec](../product/PRODUCT-SPEC.md). If this plan conflicts with it, the Product Spec wins and implementation pauses until this plan is corrected.

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Use a disposable Outline workspace and canary documents for live proofs; never mutate production knowledge without explicit authority.

**Goal:** Make Outline genuinely bidirectional for two members and agent runs while preserving native attribution, exact scopes/revisions, conflict safety, revocation, and source-body minimization.

**Phase requirements:** `OUT-001` through `OUT-010`.

## Entry gate

- Foundation identity, exact-revision operation authorization, encrypted credentials, audit, backup/restore, Context Recipes, and offboarding pass.
- A disposable Outline workspace has two delegated member identities, one bot identity, an allowed collection, a denied collection, and canary documents.
- GitHub is not a technical dependency for this phase.

## Stable Outline interfaces

```ts
// src/server/adapters/outline/contract.ts
export interface OutlinePort extends ContextConnector<OutlineReference, OutlineDocument, OutlineMutation> {
  exchangeMemberGrant(command: ExchangeOutlineOAuthGrant): Promise<Result<DelegatedOutlineGrant>>;
  revokeMemberGrant(command: RevokeOutlineOAuthGrant): Promise<Result<GrantRevocation>>;
  inspectBotConnection(query: InspectOutlineBot): Promise<Result<OutlineBotConnection>>;
}

// src/server/modules/documents/contract.ts
export interface DocumentCollaboration {
  grant(command: CreateDocumentWriteGrant): Promise<Result<DocumentWriteGrant>>;
  propose(command: ProposeDocumentChange): Promise<Result<DocumentProposal>>;
  apply(command: ApplyDocumentProposal): Promise<Result<Observed<OutlineDocumentReference>>>;
  revoke(command: RevokeDocumentWriteGrant): Promise<Result<GrantRevocation>>;
}
```

`OutlineMutation` is a closed union of supported non-destructive human edits, agent proposal application, and exact-grant working-document edits. There is no generic endpoint, document-ID, or Markdown pass-through outside current Context Read Scope and operation authority.

## Task Group 1: Delegated OAuth, bot identity, credentials, and scope

**Requirements:** `OUT-001`, `OUT-002`.

**Files:**

- Create `src/server/db/migrations/0009_outline.sql` and verifier.
- Create `src/shared/contracts/outline.ts`.
- Create `src/server/adapters/outline/{contract,oauth,bot-auth,client,scope}.ts`.
- Create `src/server/modules/connectors/outline-credentials.ts`.
- Create `src/server/adapters/http/routes/connectors-outline.ts`.
- Create `src/web/features/outline/connection/`.
- Test `tests/unit/outline/scope.test.ts`, `tests/integration/outline/{oauth,bot-attribution,scope}.test.ts`, `tests/e2e/outline-connection.spec.ts`.

**Test-first sequence:**

- [ ] Test OAuth state/PKCE, callback identity binding, refresh rotation, revocation, bot/member credential separation, and encrypted-at-rest metadata.
- [ ] Test effective scope as connected workspace plus project Context Read Scope plus current delegated/bot authority.
- [ ] Implement member and bot credential adapters without exposing tokens to browser, runner, MCP, or durable run context.
- [ ] Run the narrow unit/integration/browser suites; expect PASS.

**Security drill:** Replay callback, swap member identity, return a denied-collection result, revoke refresh grant, restore an old backup, and rotate connector epoch. No stale credential or out-of-scope reference succeeds.

## Task Group 2: Federated search, reads, references, and data minimization

**Requirements:** `OUT-003`; connector refinement for `ORP-04`.

**Files:**

- Create `src/server/adapters/outline/{search,documents}.ts`.
- Create `src/server/modules/federated-search/{contract,search}.ts`.
- Create `src/server/modules/context/outline-reference-provider.ts`.
- Create `src/server/adapters/http/routes/outline-search.ts` and `src/server/adapters/mcp/outline-tools.ts`.
- Create `src/web/features/outline/search/`.
- Test `tests/integration/outline/{search,read,data-minimization}.test.ts`, `tests/protocol/outline-surface-parity.test.ts`.

**Test-first sequence:**

- [ ] Seed allowed/denied canary documents and write failing tests for live fan-out, normalized reference metadata, bounded preview, current revision, and no server-side body cache.
- [ ] Implement search/read through `OutlinePort`; Context Recipes receive references and optional bounded preview only.
- [ ] Test HTTP and MCP semantic parity, current-scope revalidation, stale/unavailable results, and provenance.
- [ ] Scan SQLite, audit payloads, logs, backup classification, and runner outbox fixtures for canaries.
- [ ] Run the narrow suites; expect PASS.

## Task Group 3: Human editing and exact-revision conflict behavior

**Requirements:** `OUT-004`.

**Files:**

- Create `src/server/adapters/outline/{human-editing,revision-cas}.ts`.
- Create `src/server/modules/documents/human-editing.ts`.
- Create `src/server/adapters/http/routes/outline-documents.ts`.
- Create `src/web/features/outline/editor/`.
- Test `tests/integration/outline/{human-editing,revision-conflict}.test.ts`, `tests/e2e/outline-coediting.spec.ts`.

**Test-first sequence:**

- [ ] Write two-writer tests with exact observed revision and action digest.
- [ ] Require the authenticated delegated member identity for direct human edits; bot credentials are rejected for this path.
- [ ] Implement read-compare-write or native conditional mutation with an explicit residual-race result.
- [ ] Prove stale saves preserve both authored change and latest source reference for focused resolution.
- [ ] Implement direct human document creation through the delegated member identity with collection scope and exact returned revision; destructive move/archive/delete remains separately approval-gated.
- [ ] Run integration and two-browser co-edit journeys; expect PASS.

**Failure drill:** Revoke member OAuth after editor load, change collection scope, delete/move document, and race an external update. No stale browser session overwrites current content.

## Task Group 4: Exact Document Write Grants and agent iteration

**Requirements:** `OUT-005`.

**Files:**

- Create `src/server/db/migrations/0010_outline_grants.sql` and verifier.
- Create `src/shared/contracts/document-grants.ts`.
- Create `src/server/modules/documents/{contract,write-grants,agent-operations}.ts`.
- Create `src/server/modules/execution-authority/outline-operations.ts`.
- Create MCP tools `src/server/adapters/mcp/document-tools.ts`.
- Test `tests/unit/documents/write-grants.test.ts`, `tests/integration/outline/agent-grants.test.ts`.

**Test-first sequence:**

- [ ] Property-test grants against run ID, exact document IDs, operation set, expiry, connector epoch, member revision, and grant revision.
- [ ] Prove another run/document/destructive action and a changed exact approval subject fail.
- [ ] Test additional-document requests as non-authorizing requests; only an explicit member decision extends the exact existing-run grant.
- [ ] Implement operation-level authorization immediately before every bot mutation; historical envelope is a ceiling, not current permission.
- [ ] Run unit and integration suites; expect PASS.

**Security drill:** Forge document ID, reuse operation permit, change source revision, revoke grant between authorization and connector call, and remove dispatcher. All fail closed with auditable disposition.

## Task Group 5: Proposals, conflicts, and External Working Documents

**Requirements:** `OUT-006`, `OUT-007`.

**Files:**

- Create `src/server/db/migrations/0011_outline_proposals.sql` and verifier.
- Create `src/shared/contracts/document-proposals.ts`.
- Create `src/server/modules/documents/{proposals,conflicts,working-documents}.ts`.
- Create `src/web/features/outline/{proposals,working-documents}/`.
- Test `tests/unit/documents/proposals.test.ts`, `tests/integration/outline/{proposal-conflict,working-document}.test.ts`, `tests/e2e/outline-proposals.spec.ts`.

**Test-first sequence:**

- [ ] Test immutable proposal base revision, bounded authored patch, author/run provenance, apply decision, and latest-source conflict reference.
- [ ] Modify Outline externally between propose/apply and prove application creates conflict rather than overwrite.
- [ ] Test working-document linkage/editing without implicit canonical status or run completion coupling.
- [ ] Test explicit `KEEP`, `PROMOTE`, and `ARCHIVE` dispositions. Keep is the no-action default; Promote and Archive are separately authorized Outline operations.
- [ ] Persist only source identifiers/revisions and the bounded authored proposal or patch. Fetch current source bodies on demand during authorized resolution and prove fetched base/current bodies never enter coordination storage or backups.
- [ ] Run all narrow suites; expect PASS.

## Task Group 6: Revocation, canary scans, and two-member dogfood

**Requirements:** `OUT-008`, `OUT-009`, `OUT-010`; completes Outline part of `ORP-15`.

**Files:**

- Create `src/server/modules/documents/revocation.ts`.
- Create `tests/drills/outline-revocation.test.ts`, `outline-data-canary.test.ts`, `outline-conflict.test.ts`.
- Create `tests/e2e/outline-dogfood.spec.ts`.

**Test-first sequence:**

- [ ] Revoke member OAuth, bot connection, connector scope, and Document Write Grant during pending and active operations; assert current revision is rechecked and future actions stop.
- [ ] Insert a unique canary into source bodies; exercise search, read, human edit, agent grant, proposal, conflict, network disconnect, backup, and restore fixtures.
- [ ] Scan application logs, audit payloads, SQLite coordination tables, authenticated backup contents outside encrypted credential storage, and runner outboxes for the canary.
- [ ] Execute live two-member dogfood with correct native attribution and attach Outline revisions plus Collab run/grant/proposal/audit IDs.

## Verification commands

```bash
bun run format:check && bun run lint && bun run typecheck
bun test tests/unit/outline tests/unit/documents tests/integration/outline tests/protocol/outline-surface-parity.test.ts
bun test tests/drills/outline-*.test.ts
bun run build && bun run test:e2e -- outline-connection.spec.ts outline-coediting.spec.ts outline-proposals.spec.ts outline-dogfood.spec.ts
```

Expected: all exit 0. Repeat attribution, conflict, revocation, and canary journeys against the approved disposable Outline workspace.

## Canonical Product Spec exit criterion

> Exit when two members can co-edit an Outline document through Collab with correct native attribution; an agent can iterate only inside an exact grant; concurrent external edits create a conflict proposal; revoked member and bot grants stop new external operations; and no raw document body appears in run logs, backups outside encrypted connector storage, or runner outboxes.

## Phase exit gate

- `OUT-001` through `OUT-010` are `PASS`.
- The canonical criterion above is retained unchanged in evidence.
- Member OAuth, bot identity, Context Read Scope, exact grants, proposal conflicts, and every revocation cause have distinct audit evidence.
- Canary scans prove document-body minimization in every named prohibited store.

## Rollback boundary

Disable member and bot grants, increment Outline connector epoch, stop queued external operations, and retain references/proposals as stale read-only coordination evidence. Restore the pre-migration authenticated backup if schema rollback is required. Externally confirmed Outline edits remain native source history and are never undone to imitate database rollback.
