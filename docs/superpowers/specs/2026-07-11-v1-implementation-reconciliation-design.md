# 2Collab V1 Implementation Reconciliation Design

**Status:** APPROVED FOR IMPLEMENTATION  
**Date:** 2026-07-11  
**Scope:** Reconcile the canonical Product Spec, accepted ADRs, derived architecture, acceptance matrix, and phase plans before implementing all four v1 slices.

## Objective

Implement the complete v1 Product Spec without replacing authoritative GitHub or Outline state, weakening runner security, inventing a second workflow model, or treating unexecuted schema and mock UI as acceptance evidence. Implementation continues across all phases before timed and live dogfood evidence is available, but those requirements remain `IN_PROGRESS` or `BLOCKED` until their actual proof exists.

## Decision hierarchy

The Product Spec remains canonical. Accepted ADRs may amend only an explicitly named decision. Architecture and security documents resolve implementation shape when they agree with the Product Spec. This design corrects omissions and contradictions in the acceptance matrix and phase plans; it does not narrow a Product Spec requirement.

## Architecture

The repository remains one Bun 1.3.10 and TypeScript package with exactly two artifacts:

- `collab-server` owns the web application, authenticated HTTP and MCP transports, SSE, webhook ingestion, coordination state, identity, workflows, connector credentials, scheduling, projections, SQLite migrations, and backup/restore operations.
- `collab` owns local project discovery, device and runner credentials, the runner daemon, cache/outbox, worktrees, process supervision, Native and Orca hosts, Claude and Codex runtime adapters, local gates, interactive attachment, and the local stdio MCP bridge.

The allowed dependency direction is `shared contracts <- domain <- server or runner modules <- adapters and composition roots`. React, Hono, provider response objects, WSS frames, shell commands, and absolute paths never enter domain interfaces.

## Deep-module decisions

### ExecutionAuthority

The higher-precedence architecture contract governs:

```ts
export interface ExecutionAuthority {
  preview(request: AuthorityPreviewRequest): Promise<AuthorityPreview>;
  execute<C extends CollabCommand>(command: C): Promise<Result<CommandResultFor<C>>>;
  query<Q extends CoordinationQuery>(query: Q): Promise<Result<QueryResultFor<Q>>>;
}
```

`CollabCommand` is a closed discriminated union. It includes `LAUNCH_RUN`, `AUTHORIZE_ATTEMPT`, attempt events, checkpoints, bounded evidence, typed Run Results, source-reference linking, cancellation, permit consumption, session renewal, sensitive-operation authorization, session release, runner-policy replacement, collision acknowledgement, reconciliation, and revocation. It has no generic executable or provider-payload escape hatch.

`LAUNCH_RUN` with new coordination creates the Coordination Record, Agent Run, first `PENDING` Execution Attempt, Authority Snapshot, single-use Dispatch Permit, mutation reservation when required, audit event, and WSS outbox intent in one SQLite transaction. `AUTHORIZE_ATTEMPT` handles retry, resume, Managed Loop iteration, and human-decision continuation with a fresh decision.

SQLite is a private local-substitutable seam. Runner WSS uses a private remote-owned port with production and in-memory adapters. GitHub and Outline use narrow true-external ports with production and strict mock adapters.

The implementation is internally divided into lifecycle, authority, evidence, source-linking, idempotency, transaction, audit, and projection modules. Those are private implementation seams. Web, CLI, MCP, scheduler, workflow, connector, and runner adapters all cross the same three-entry public interface and never coordinate internal ordering themselves.

### IdentityAuthority

The identity module must include one-time bootstrap, passkey registration/authentication/revocation, recovery-code generation/redemption, invitation create/inspect/revoke/accept, role changes with fresh verification, session/device management, offboarding, OIDC identity linking, authenticated-proxy identity linking, and container-only owner recovery. HTTP routes are adapters over this module; no login provider grants membership by itself.

### Connectors

Generic encrypted credential storage, connector epochs, scope policy, exact-revision operation authorization, revocation, and reconciliation primitives belong in Foundation. GitHub and Outline each implement narrow provider ports and cannot create a second credential, identity, audit, or authority implementation.

### Workflows

The executable Workflow Definition uses the canonical closed palette: `START`, `AGENT_RUN`, `HUMAN_DECISION`, `RESULT_ROUTER`, `PARALLEL_SPLIT`, `JOIN`, and `TERMINAL`. It includes typed inputs/results, transitions, join and remainder policies, total-run bounds, traversal/cycle bounds, parallel branch bounds, concurrency ceiling, and absolute deadline. Canvas Layout contains only presentation data and has an independent revision/hash.

## Canonical conflict resolutions

1. The Product Spec status becomes `accepted`; historical MTAAP discussion remains context, while the implemented product and artifacts are named 2Collab/Collab.
2. “Separate packages” means internal source modules/directories inside the one package, never additional `package.json` files or workspaces.
3. An Outline conflict stores source identifiers and revisions plus the bounded agent-authored proposal or patch. It does not persist fetched base/current document bodies. Current bodies are fetched from Outline when an authorized member resolves the conflict.
4. GitHub review and merge in the v1 dogfood journey occur in GitHub and are observed/reconciled by Collab. V1 does not gain unlisted pull-request review or merge mutations.
5. Browser projections use SSE. The runner's outbound bidirectional transport is WSS because runner dispatch and control are already a real bidirectional requirement.
6. The local global project registry is SQLite at `~/.collab/global.db`; JSON is not an alternative implementation.
7. Minimal Coordination Record creation, generic connector primitives, and safe source-reference types move into Foundation. GitHub adds canonical source mapping, late linking, and provider behavior.
8. Foundation owns every v1 authentication provider and recovery path, the local MCP bridge, all composition roots, and verification-script coverage for unit, integration, protocol, runner, drill, and browser suites.
9. Outline adds document creation, additional-document grant requests, and explicit working-document `KEEP`, `PROMOTE`, and `ARCHIVE` dispositions.
10. Workflow authoring includes revisioned shared drafts, stale-draft duplication, undo/redo, YAML import/export over the canonical schema, HTTP/CLI/MCP parity, keyboard operation, and a synchronized structured outline.

## Operational defaults

Defaults are deployment configuration with hard positive validation; active runs snapshot effective values so later configuration cannot widen them.

| Policy | Default |
|---|---:|
| Team invitation expiry | 48 hours |
| Invitation exchange session | 15 minutes |
| Fresh privileged verification | 5 minutes |
| Browser idle / absolute session | 12 hours / 7 days |
| Recovery session | 15 minutes |
| Dispatch Permit lifetime | 30 seconds |
| Authority Session lifetime / renewal cadence | 30 seconds / 10 seconds |
| Mutation disconnect grace | 15 seconds |
| Runner heartbeat / offline / lost grace | 10 / 30 / 90 seconds |
| Structured WSS frame | 64 KiB |
| Live output chunk / in-memory reconnect buffer | 16 KiB / 1 MiB per attempt |
| Runner reconnect maximum backoff | 30 seconds |
| Source-unavailable automatic refresh grace | 5 minutes |
| Encrypted local diagnostic tail | 2 MiB and 24 hours |
| Resolved Inbox retention | 90 days |

Every limit is configurable only within a positive, finite validated range. No sentinel disables a deadline, bound, expiry, or output cap.

## Data rules

Durable server storage may contain authored instruction components, bounded user-approved previews, lifecycle events, typed results, checkpoints, revisions, hashes, source references, audit records, and bounded structured evidence.

It must not contain raw terminal output, interactive transcripts, flattened prompts, fetched source bodies, raw diffs, environment dumps, credentials, private profile arguments, absolute local paths, or worktree contents. Provider credentials are envelope-encrypted; the deployment master key remains outside SQLite and its backup.

## Error model

Expected domain and authority rejection is a typed result with a stable uppercase code, safe bounded message, retry disposition, and optional safe scalar details. Storage corruption, unavailable internal infrastructure, and programmer defects use an internal failure with a correlation identifier. No response echoes raw provider errors, secrets, environment values, commands, source bodies, or paths.

## Test strategy

Every executable behavior begins with a failing Bun test and an observed behavioral failure. Tests cross the same deep-module interfaces used by production callers.

- Unit tests cover pure schemas, transition tables, policy, hashing, validation, and three-valued logic.
- Integration tests use isolated real SQLite databases and strict in-memory runner/provider adapters.
- Protocol tests prove HTTP/CLI/MCP parity and WSS schema, replay, bounds, and secret minimization.
- Runner tests exercise real temporary git repositories, worktrees, subprocess supervision, Native/Orca and Claude/Codex conformance fixtures, gates, cache/outbox, and cleanup.
- Browser tests prove the approved journeys, accessibility semantics, responsive behavior, and React Flow separation.
- Drills cover revocation, network partition, restore, stale revisions, missed events, duplicate delivery, deadlines, and no parked processes.
- Live dogfood evidence is additional. Local mocks never receive `PASS` for a live requirement.

## Delivery sequence

1. Foundation contracts, identity, persistence, projects, runner, authority, source-free runs, surfaces, offline safety, and operations.
2. GitHub and Outline modules after their shared Foundation prerequisites exist. Their local implementations and strict fixtures may proceed before live Foundation dogfood completes.
3. Bounded automation after local GitHub contracts, exact-SHA evidence, and Foundation run/workflow prerequisites are implemented.
4. Full local verification and adversarial review.
5. External/timed evidence ledger listing the real resources and elapsed proof still required.

This sequence implements the complete codebase without falsely declaring timed or provider-backed acceptance evidence.
