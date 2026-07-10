# Phase 2: GitHub Coordination Implementation Plan

> **Authority: Derived implementation guidance.** The canonical product authority is the [Product Spec](../product/PRODUCT-SPEC.md). If this plan conflicts with it, the Product Spec wins and implementation pauses until this plan is corrected.

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Use a disposable GitHub organization/repository for live proofs; never mutate production resources without explicit authority.

**Goal:** Carry one real GitHub issue through authoritative triage, delegation, local implementation, pull-request delivery, review, merge, and observed closure without copying GitHub's lifecycle into Collab.

**Phase requirements:** `GHB-001` through `GHB-015`.

## Entry gate

- Foundation requirements `FND-001`–`FND-019` pass.
- Exact-revision operation authorization, encrypted credential storage, audit, backup/restore, and member offboarding are available.
- A disposable GitHub App installation and organization-owned Project are approved for tests.

## Stable GitHub interfaces

```ts
// src/server/adapters/github/contract.ts
export interface GitHubPort extends SourceConnector<GitHubReference, GitHubProjection, GitHubMutation> {
  observeChecks(reference: PublishedGitReference): Promise<Result<readonly GitHubCheckObservation[]>>;
  listDependencies(reference: GitHubWorkItemReference): Promise<Result<Observed<readonly SourceDependency[]>>>;
}

// src/server/modules/coordination-records/contract.ts
export interface CoordinationRecordRegistry {
  resolve(command: ResolveCoordinationRecord): Promise<Result<CoordinationRecord>>;
  link(command: LinkSourceReference): Promise<Result<CoordinationRecord>>;
  inspect(query: InspectCoordinationRecord): Promise<Result<CoordinationRecordView>>;
}
```

`GitHubMutation` is a discriminated union of explicitly supported issue, pull-request, Milestone, and selected-Project actions. It has no generic REST/GraphQL escape hatch. Every replace-style mutation carries `expectedRevision` and `actionDigest`.

## Task Group 1: GitHub App credentials, scopes, webhooks, and reconciliation

**Requirements:** `GHB-001`, `GHB-002`.

**Files:**

- Create `src/server/db/migrations/0101_github.sql` and verifier.
- Create `src/shared/contracts/github.ts`.
- Create `src/server/adapters/github/{contract,app-auth,client,scope,webhooks,reconciliation}.ts`.
- Extend the Foundation `src/server/modules/connectors/{credentials,epochs,scope-policy}.ts` primitives only through their existing typed interfaces.
- Create `src/server/adapters/http/routes/connectors-github.ts`.
- Test `tests/unit/github/`, `tests/integration/github/app-scope.test.ts`, `webhook-reconciliation.test.ts`.

**Test-first sequence:**

- [ ] Write fixtures for installation scope, selected repositories, selected Projects, webhook signature, delivery deduplication, missed delivery, rate limits, and epoch changes.
- [ ] Test that effective reach is the exact intersection of App permissions and owner selection.
- [ ] Implement encrypted credentials, signed webhook ingestion, refreshable projections, and periodic reconciliation.
- [ ] Run `bun test tests/unit/github tests/integration/github/app-scope.test.ts tests/integration/github/webhook-reconciliation.test.ts`; expect PASS.

**Security drill:** Return an item from an unselected repository through organization Project discovery, replay a webhook, rotate the App key, restore an old backup, and narrow scope. No prohibited body persists or mutation succeeds.

## Task Group 2: Issues, pull requests, Milestones, and selected Projects

**Requirements:** `GHB-003`, `GHB-004`, `GHB-005`.

**Files:**

- Create `src/server/adapters/github/{issues,pull-requests,milestones,projects,revision-cas}.ts`.
- Create `src/server/modules/source-projections/{store,mutations}.ts`.
- Create `src/server/adapters/http/routes/{github-issues,github-planning}.ts`.
- Create `src/web/features/github/{issues,pull-requests,milestones,projects}/`.
- Test `tests/integration/github/{issues,pull-requests,milestones,projects,revision-cas}.test.ts`, `tests/e2e/github-planning.spec.ts`.

**Test-first sequence:**

- [ ] Write contract tests for every supported mutation and explicit rejection of unsupported/destructive operations.
- [ ] Write a two-writer stale-edit test before implementing replace-style edits.
- [ ] Implement source-first mutation: authorize exact action, call GitHub with precondition or read-compare-write, then persist the confirmed projection and provenance.
- [ ] Test Project-by-repository intersection and redacted unsupported references.
- [ ] Run the narrow connector and browser suites; expect PASS.

**Failure drill:** Make GitHub reject an assignee, rename/delete a Project field, change a document between compare and write, and exhaust rate limit. Collab refreshes and reports failure without optimistic source state.

## Task Group 3: Canonical coordination, Assignment, Delegation, and delivery

**Requirements:** `GHB-006`, `GHB-007`, `GHB-008`.

**Files:**

- Create `src/server/db/migrations/0102_coordination_source_mapping.sql` and verifier; Foundation already owns Coordination Records and mutation guards.
- Create `src/shared/contracts/coordination-records.ts`.
- Extend `src/server/modules/coordination-records/{canonical-key,registry,source-links}.ts` with provider canonical mapping, late linking, and audited coalescing.
- Create `src/server/modules/github-coordination/{assignment,delegation,delivery}.ts`.
- Create `src/server/adapters/http/routes/coordination-records.ts` and MCP tools in `src/server/adapters/mcp/github-tools.ts`.
- Test `tests/integration/coordination-records/`, `tests/integration/github/assignment-delegation.test.ts`, `delivery.test.ts`.

**Test-first sequence:**

- [ ] Race source-free creation, issue-origin creation, and late linking; assert one project/source canonical record and immutable run IDs.
- [ ] Force both Assignment/Delegation partial-success directions and assert independent audit/result values.
- [ ] Generate closing reference from exact repository/issue identity, publish a verified ref, and wait for GitHub-reported closure.
- [ ] Test merged PR with open issue and reopened issue; no completed run is reopened.
- [ ] Run the narrow suites; expect PASS.

## Task Group 4: Dependencies, mutation guards, collisions, diff evidence, and checks

**Requirements:** `GHB-009`–`GHB-012`; owns `ORP-07` and GitHub half of `ORP-14`.

**Files:**

- Create `src/server/modules/coordination-records/{mutation-guard,collisions}.ts`.
- Create `src/server/modules/evidence/{diff-evidence,github-checks}.ts`.
- Create `src/server/modules/github-coordination/dependencies.ts`.
- Create `src/runner/repository/changed-paths.ts`.
- Test `tests/integration/coordination-records/{mutation-guard,collisions}.test.ts`, `tests/integration/github/{dependencies,checks}.test.ts`, `tests/integration/evidence/diff-evidence.test.ts`.

**Test-first sequence:**

- [ ] Test one default mutator per record, explicit override audit, same-target-branch hard block, and cross-record advisory path overlap.
- [ ] Test bounded/truncated Changed-Path Snapshots and path-free collision audit retention.
- [ ] Test diff evidence contains identifiers/stats only and old-SHA checks become stale after head change.
- [ ] Test unresolved/stale/unavailable dependencies warn but do not block launch or transition runs.
- [ ] Run all narrow tests; expect PASS.

**Security drill:** Submit traversal/control/oversized paths, a raw diff, wrong repository identity, and a check conclusion for another SHA. Each is rejected or marked incomplete/stale.

## Task Group 5: Revocation, Inbox, Command Center, and live dogfood

**Requirements:** `GHB-013`, `GHB-014`, `GHB-015`; completes connector part of `ORP-15`.

**Files:**

- Create `src/server/db/migrations/0103_github_attention.sql` and verifier.
- Create `src/server/modules/inbox/{events,inbox,command-center}.ts`.
- Create `src/web/features/{inbox,command-center}/`.
- Create `tests/drills/github-scope-narrowing.test.ts`, `github-member-offboarding.test.ts`, `github-missed-webhook.test.ts`.
- Create `tests/e2e/github-delivery.spec.ts`.

**Test-first sequence:**

- [ ] Test scope epoch/member revision on every new operation; remove a member and narrow repository/Project scope during active work.
- [ ] Test attention-event deduplication, personal read state, derived lanes, and absence of draggable lifecycle writes.
- [ ] Run missed-webhook and stale-edit drills against fixtures, then the same journeys against disposable live GitHub resources.
- [ ] Complete the real issue-to-observed-closure dogfood journey and attach source URLs/revisions, Collab record/run IDs, audit IDs, and sanitized evidence.

Pull-request review and merge remain GitHub-native actions in this journey. Collab links to them, observes signed webhooks and reconciliation results, and records exact revisions; it does not submit reviews or merge pull requests through an unlisted mutation.

## Verification commands

```bash
bun run format:check && bun run lint && bun run typecheck
bun test tests/unit/github tests/integration/github tests/integration/coordination-records tests/integration/evidence tests/protocol
bun test tests/drills/github-*.test.ts
bun run build && bun run test:e2e -- github-planning.spec.ts github-delivery.spec.ts
```

Expected: all exit 0. Repeat the scoped connector, reconciliation, stale edit, and closing journey against the approved disposable live installation.

## Canonical Product Spec exit criterion

> Exit when a real connected issue can be triaged, assigned, delegated, implemented, published with a closing reference, reviewed, merged, and observed closing from GitHub without Collab fabricating source state; missed webhook reconciliation, stale replace-style edits, late source linking, and connector scope narrowing are exercised successfully.

## Phase exit gate

- `GHB-001` through `GHB-015` are `PASS`.
- The canonical criterion above is retained unchanged in evidence.
- Advisory dependencies, late-link canonicalization, member offboarding, and exact-SHA check observation are proven explicitly.
- Storage scan finds no raw source diff or unselected repository content.

## Rollback boundary

Disable the GitHub connector, increment its authority epoch, stop queued mutations, preserve source projections as stale read-only evidence, and restore the authenticated pre-migration backup if schema rollback is required. Never attempt compensating GitHub mutations to imitate database rollback; externally confirmed mutations remain GitHub history.
