# 2Collab V1 Master Implementation Plan

> **Authority: Derived implementation guidance.** The canonical product authority is the [Product Spec](../product/PRODUCT-SPEC.md). If this plan conflicts with the Product Spec, stop, record the conflict, correct the plan, and do not silently amend product behavior.

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans` phase-by-phase. Run every task group test-first and attach evidence before advancing a gate.

**Goal:** Implement the four vertically usable Product Spec slices as one Bun/TypeScript package producing `collab-server` and `collab`, while preserving one authority model, one domain model, and one testable interface per external seam.

**Architecture:** `collab-server` owns SQLite coordination state, web/API/MCP adapters, connector credentials, scheduling, and projections. `collab` owns local project discovery, runner pairing, worktrees, runtime/host adapters, and the outbound WSS data plane. Domain modules are transport-agnostic; HTTP, MCP, CLI, WSS, SQLite, GitHub, Outline, Native, and Orca are adapters around stable interfaces.

**Tech Stack:** Bun 1.3+, TypeScript 7, Hono 4, React 19, Vite 8, React Flow 12, Zod 4, `bun:sqlite`, WebAuthn, Bun test, Playwright, Docker Compose.

**Migration reconciliation:** The immutable Foundation history includes corrective migration `0006_foundation_configuration_corrections`. The remaining phase ranges are therefore GitHub `0007-0009`, Outline `0010-0012`, and Automation `0013-0015`.

## Global constraints

- The [Acceptance Matrix](../acceptance/ACCEPTANCE-MATRIX.md) IDs are stable. Never renumber an accepted requirement; mark supersession explicitly.
- UPPERCASE values are required for persisted enum-like state.
- Every write command has an idempotency key, authenticated actor, expected revision, and structured result.
- The Product Spec remains canonical; these plans are derived authority.
- SQLite is the only v1 coordination database. No ORM or PostgreSQL abstraction is added speculatively.
- Raw prompts, terminal transcripts, source bodies, source diffs, environments, credentials, and absolute local paths never enter durable server coordination storage.
- Native and Orca trusted-host repository controls report `ADVISORY`; only a real isolation adapter may report `ENFORCED`.
- Web, CLI, MCP, workflow, and scheduler callers invoke the same domain interfaces.
- Every phase follows red-green-refactor and lands with migrations, rollback/restore notes, security drills, and an evidence record.
- No phase may push, merge, release, mutate production connectors, or post public comments without explicit authority.

## Intended source tree and dependency direction

```text
src/shared/contracts/             transport-safe IDs, commands, events, errors
src/domain/                       pure entities, invariants, policies
src/server/db/                    SQLite connection, migrations, transactions
src/server/modules/identity/      members, sessions, invitations, recovery
src/server/modules/projects/      projects and connector scope configuration
src/server/modules/runs/          Agent Run, Attempt, checkpoint, evidence
src/server/modules/execution-authority/
src/server/modules/coordination-records/
src/server/modules/inbox/
src/server/modules/workflows/
src/server/adapters/http/         Hono routes only
src/server/adapters/mcp/          MCP protocol translation only
src/server/adapters/wss/          runner transport only
src/server/adapters/github/       GitHub App and API implementation
src/server/adapters/outline/      delegated OAuth and bot implementation
src/runner/                       local runner supervisor
src/runner/adapters/runtime/      Claude, Codex
src/runner/adapters/host/         Native, Orca
src/runner/adapters/enforcement/  advisory trusted-host, future enforced
src/runner/repository/            discovery, worktrees, publish, cleanup
src/cli/                          commands over domain client interfaces
src/web/features/                 React feature slices over typed HTTP client
tests/unit/                       pure policy and schema tests
tests/integration/                SQLite/module/adapter contract tests
tests/protocol/                   WSS, MCP, HTTP compatibility/security
tests/e2e/                        browser/CLI journeys
tests/fixtures/                   external and failure fixtures
tests/drills/                     executable restore/network/revocation drills
```

Allowed dependency direction is `shared contracts <- domain <- modules <- adapters/entry points`. Web, CLI, MCP, connectors, and transports cannot import one another. Runner runtime adapters cannot call server persistence or connectors. Add `tests/unit/architecture/dependency-direction.test.ts` before the first product module and fail on forbidden imports.

## Stable shared interfaces

Create these interfaces in Foundation and extend implementations, not callers, in later phases.

```ts
// src/shared/contracts/result.ts
export type DomainError = Readonly<{
  code: string;
  message: string;
  retry: "NEVER" | "REFRESH" | "EXPLICIT_RESUME" | "SAME_INPUT";
  details?: Readonly<Record<string, string | number | boolean>>;
}>;
export type Result<T> =
  | Readonly<{ ok: true; value: T; auditId?: string }>
  | Readonly<{ ok: false; error: DomainError; auditId?: string }>;

// src/server/modules/execution-authority/contract.ts
export interface ExecutionAuthority {
  preview(request: AuthorityPreviewRequest): Promise<AuthorityPreview>;
  execute<C extends CollabCommand>(command: C): Promise<Result<CommandResultFor<C>>>;
  query<Q extends CoordinationQuery>(query: Q): Promise<Result<QueryResultFor<Q>>>;
}

// src/server/modules/connectors/contract.ts
export interface SourceConnector<TReference, TProjection, TMutation> {
  inspect(scope: ConnectorScope, reference: TReference): Promise<Result<Observed<TProjection>>>;
  mutate(authorization: ConnectorOperationAuthorization, command: ExactRevisionMutation<TMutation>): Promise<Result<Observed<TProjection>>>;
  scan(scope: ConnectorScope, cursor?: ReconciliationCursor): AsyncIterable<Result<ReconciliationEvent<TProjection>>>;
}
export interface ContextConnector<TReference, TLiveRead, TProjection, TMutation> {
  search(scope: ConnectorScope, query: ScopedSearch): Promise<Result<EphemeralSearchPage<TReference>>>;
  read(scope: ConnectorScope, reference: TReference): Promise<Result<EphemeralObserved<TLiveRead>>>;
  mutate(authorization: ConnectorOperationAuthorization, command: ExactRevisionMutation<TMutation>): Promise<Result<Observed<TProjection>>>;
}

// src/server/modules/workflows/contract.ts
export interface WorkflowEngine {
  publish(command: PublishWorkflowVersion): Promise<Result<WorkflowVersion>>;
  start(command: StartWorkflow): Promise<Result<WorkflowExecution>>;
  accept(command: WorkflowEventCommand): Promise<Result<WorkflowExecution>>;
  decide(command: RecordHumanDecision): Promise<Result<WorkflowExecution>>;
}
```

The full authority command types live in `src/shared/contracts/execution-authority.ts`; connector exact revisions in `src/shared/contracts/connectors.ts`; run/workflow state in `src/shared/contracts/runs.ts` and `workflow.ts`. Zod schemas with the same names plus `Schema` suffix validate every external frame.

## Database migration ownership

| Phase | Migration files | Owned schema groups |
|---|---|---|
| Foundation | `src/server/db/migrations/0001_foundation.sql` through corrective `0006_foundation_configuration_corrections.sql` | deployment, members, credentials, sessions, upgrade-safe Projects/base branches, generic connector epochs/scopes, runners, policies, Coordination Records, source links, mutation guards, runs, attempts and causes, permits, authority sessions, checkpoints, evidence, immutable configuration snapshots, presets, audit, outbox, backup metadata |
| GitHub | `src/server/db/migrations/0007_github.sql` through `0009_github_attention.sql` | connector installations/scopes, source projections, canonical aliases/source links, mutation provenance, collision summaries, inbox |
| Outline | `src/server/db/migrations/0010_outline.sql` through `0012_outline_proposals.sql` | delegated grants, bot connection, read scopes, document references, write grants, proposals, working-document references |
| Automation | `src/server/db/migrations/0013_workflows.sql` through `0015_gates_telemetry.sql` | template versions, workflow definitions/layouts, presets, executions, steps, results, decisions, stop state, gates, evaluations, usage aggregation |

Every migration has an adjacent `*.verify.ts` integration test that opens the previous schema fixture, migrates forward, verifies invariants, and proves backup/restore compatibility. Destructive rollback is never improvised; rollback means restore the pre-migration authenticated backup and run the recorded schema compatibility check.

## Test-first task protocol

For every task group in a phase plan:

1. Add the named failing test at the exact path.
2. Run the narrow command and confirm the expected failure is behavioral, not environment-related.
3. Add the minimal implementation at the named module paths.
4. Re-run narrow tests, then `bun run typecheck && bun run lint`.
5. Refactor only while the narrow and phase suites remain green.
6. Record requirement IDs and evidence locations in `docs/evidence/<phase>/<build-id>.md`.

## Phase order and entry gates

1. **Foundation** starts from the verified repository seed. Exit requires all `FND-*` requirements.
2. **GitHub coordination** starts only after Foundation security, authority, backup, and runner gates pass.
3. **Outline collaboration** starts only after the same Foundation gate. It may execute alongside GitHub but cannot duplicate identity, credentials, exact-revision mutation, or revocation logic.
4. **Bounded automation** starts after Foundation and GitHub exit because its canonical dogfood operates on a real pull request. Outline is not a required runtime dependency.

### Implementation sequencing versus acceptance evidence

Local implementation may proceed into a later phase after the earlier phase's shared interfaces, migrations, local security suites, and strict fixture contracts pass, even when a timed or disposable-provider dogfood proof is still `IN_PROGRESS` or `BLOCKED`. This code-ahead rule does not convert mocked or unexecuted behavior into `PASS`: the Acceptance Matrix status changes only when its exact observable proof is captured from running software. GitHub and Outline may therefore be implemented against strict local adapters after Foundation's local prerequisites exist, and bounded automation may be implemented after local GitHub exact-revision and check-observation contracts exist.

### Integration policy

`main` is the integration trunk. A phase implementation may advance `main` after its locally achievable package, security, migration, and composition gates pass, while separately identified live-provider, multi-machine, reviewer, or timed evidence remains `IN_PROGRESS_EXTERNAL`. Later phase work branches from that verified integration revision and must not relabel pending external evidence as `PASS`.

GitHub coordination and Outline collaboration may proceed in parallel after the Foundation local gate. Bounded automation may begin after the integrated GitHub exact-revision mutation and check-observation contracts pass locally. Each parallel stream owns its phase-specific adapters, migrations, modules, UI, tests, and evidence; changes to shared contracts or authority behavior require integration review before another stream builds on them.

## Fifteen orphan risks: master disposition

| ID | Risk | Phase/task owner |
|---|---|---|
| `ORP-01` | Team onboarding/owner promotion | Foundation Task Group 1, `FND-002` |
| `ORP-02` | Shared runners/exposures | Foundation Task Group 3, `FND-015` |
| `ORP-03` | MCP parity | Foundation Task Group 5, `FND-014` |
| `ORP-04` | Context Recipes | Foundation Task Group 4; GitHub/Outline connector refinements |
| `ORP-05` | Usage telemetry | Foundation Task Group 4; Automation Task Group 6 |
| `ORP-06` | Planning workflows | Automation Task Group 5, `AUT-012` |
| `ORP-07` | Advisory dependencies | GitHub Task Group 4, `GHB-012` |
| `ORP-08` | Standalone Team Run Templates | Automation Task Group 1, `AUT-001` |
| `ORP-09` | Project discovery/global registry | Foundation Task Group 2, `FND-003` |
| `ORP-10` | Offline mutation lease | Foundation Task Group 6, `FND-009` |
| `ORP-11` | Local diagnostic tail | Foundation Task Group 3, `FND-018` |
| `ORP-12` | MCP thinness/adapter separation | Foundation Task Groups 2 and 5 architecture tests |
| `ORP-13` | Reproducible one-week dogfood | Foundation Task Group 7, `FND-019` |
| `ORP-14` | GitHub checks versus gates | GitHub `GHB-011`; Automation `AUT-009` |
| `ORP-15` | Cross-system member offboarding | Foundation `FND-002/FND-007`; GitHub `GHB-013`; Outline `OUT-008` |

## Required verification at every phase gate

Run from the repository root:

```bash
bun ci
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bunx playwright install chromium
bun run test:e2e:run
bun run audit:public
bun run manifest:verify
docker compose config --quiet
docker build --tag 2collab:verify .
```

Expected: every command exits 0. Phase-specific live connector or runner drills are additional and cannot be replaced by the common suite.

Also run:

```bash
rg -n 'TO''DO|TB''D|FIX''ME' docs/plans docs/acceptance
git diff --check
```

Expected: `rg` returns no matches and `git diff --check` exits 0.

## Final v1 exit gate

- All matrix requirements are `PASS` with build-specific evidence.
- All four canonical Product Spec exit criteria are quoted unchanged in their phase evidence.
- Restore, offboarding, network partition, connector scope narrowing, stale revision, duplicate event, and deadline drills pass.
- Web, CLI, MCP, workflow, and scheduler callers share domain behavior and stable error codes.
- No direct SQLite repair was needed during Foundation dogfood.
- No raw terminal/source body/source diff canary appears in prohibited durable stores.
- Remaining limitations are Product Spec deferrals, not unowned v1 requirements.
