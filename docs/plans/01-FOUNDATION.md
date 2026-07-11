# Phase 1: Foundation Implementation Plan

> **Authority: Derived implementation guidance.** The canonical product authority is the [Product Spec](../product/PRODUCT-SPEC.md). If this plan conflicts with it, the Product Spec wins and implementation pauses until this plan is corrected.

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Complete task groups in order with red-green-refactor evidence.

**Goal:** Deliver one secure shared source-free Agent Run across two owners, trusted local Native/Orca runners, web/CLI/MCP surfaces, and recoverable SQLite operations.

**Phase requirements:** `FND-001` through `FND-019` in the [Acceptance Matrix](../acceptance/ACCEPTANCE-MATRIX.md).

## Entry gate

- Repository seed common checks pass.
- Product Spec, execution-authority guidance, security model, and accepted ADRs exist and agree on stable terms.
- No authentication, persistence, runner, or product module from an abandoned architecture is reused without an explicit compatibility review.

## Stable phase interfaces

Implement the master-plan `Result` and three-entry `ExecutionAuthority` interface plus:

```ts
// src/server/modules/identity/contract.ts
export interface IdentityAuthority {
  bootstrap(command: BootstrapDeployment): Promise<Result<MemberSession>>;
  beginPasskeyRegistration(command: BeginPasskeyRegistration): Promise<Result<PasskeyChallenge>>;
  finishPasskeyRegistration(command: FinishPasskeyRegistration): Promise<Result<PasskeyCredential>>;
  authenticate(command: AuthenticatePasskey): Promise<Result<MemberSession>>;
  revokePasskey(command: RevokePasskey): Promise<Result<PasskeyRevocation>>;
  generateRecoveryCodes(command: GenerateRecoveryCodes): Promise<Result<RecoveryCodeSet>>;
  redeemRecoveryCode(command: RedeemRecoveryCode): Promise<Result<RecoverySession>>;
  invite(command: CreateInvitation): Promise<Result<TeamInvitation>>;
  inspectInvitation(query: InspectInvitation): Promise<Result<TeamInvitation>>;
  revokeInvitation(command: RevokeInvitation): Promise<Result<TeamInvitation>>;
  accept(command: AcceptInvitation): Promise<Result<MemberSession>>;
  changeRole(command: ChangeMemberRole): Promise<Result<Member>>;
  remove(command: RemoveMember): Promise<Result<MemberRemoval>>;
  linkProvider(command: LinkProviderIdentity): Promise<Result<LinkedIdentity>>;
  revokeSession(command: RevokeSession): Promise<Result<SessionRevocation>>;
  createHostRecovery(command: CreateHostRecovery): Promise<Result<HostRecoveryCode>>;
}

// src/server/modules/projects/contract.ts
export interface ProjectRegistry {
  register(command: RegisterProject): Promise<Result<Project>>;
  inspect(query: InspectProject): Promise<Result<Project>>;
  list(query: ListProjects): Promise<Result<readonly Project[]>>;
}

// src/server/modules/runners/contract.ts
export interface RunnerRegistry {
  pair(command: PairRunner): Promise<Result<RegisteredRunner>>;
  replacePolicy(command: ReplaceRunnerPolicy): Promise<Result<RegisteredRunner>>;
  heartbeat(command: RunnerHeartbeat): Promise<Result<RunnerLeaseView>>;
  revoke(command: RevokeRunner): Promise<Result<RunnerRevocation>>;
}

// src/runner/adapters/enforcement/contract.ts
export interface RepositoryEnforcementAdapter {
  readonly assurance: "ADVISORY" | "ENFORCED";
  activate(envelope: AuthorityEnvelope): Promise<Result<EnforcementSession>>;
  inspect(session: EnforcementSession): Promise<Result<EnforcementObservation>>;
  revoke(session: EnforcementSession, disposition: RevocationDisposition): Promise<Result<void>>;
}
```

HTTP, CLI, MCP, and WSS Zod schemas reside in `src/shared/contracts/`. Adapters translate only; they do not contain membership, run, authority, retry, revocation, or cleanup decisions.

## Task Group 1: SQLite, bootstrap, identity, and offboarding

**Requirements:** `FND-001`, `FND-002`; owns `ORP-01` and the identity part of `ORP-15`.

**Files:**

- Create `src/server/db/connection.ts`, `transaction.ts`, `migrate.ts`.
- Create `src/server/db/migrations/0001_foundation.sql` and `0001_foundation.verify.ts`.
- Create `src/server/modules/identity/{contract,identity-authority,passkeys,invitations,recovery,revocation}.ts`.
- Create `src/server/modules/identity/{sessions,csrf,devices,oidc,auth-proxy,provider-links}.ts`.
- Create `src/server/modules/connectors/{credentials,epochs,scope-policy}.ts` as shared Foundation primitives.
- Create `src/server/adapters/http/routes/{bootstrap,auth,members}.ts`.
- Create `src/server/adapters/http/middleware/{session,csrf}.ts` and `src/server/commands/auth-recover.ts`.
- Create `src/web/features/setup/` and `src/web/features/members/`.
- Test `tests/unit/identity/*.test.ts`, `tests/integration/identity/*.test.ts`, `tests/e2e/setup-and-members.spec.ts`.

**Test-first sequence:**

- [ ] Write failing invariant tests for one-time bootstrap, invitation hash/expiry/use, immutable member ID, multiple owners, fresh verification for role changes, and last-owner rejection.
- [ ] Run `bun test tests/unit/identity`; expected failure names missing identity modules.
- [ ] Implement schema and pure policies, then run the unit suite to green.
- [ ] Write integration tests proving bootstrap/accept/change/remove are single SQLite transactions and removal emits one durable `MEMBER_REMOVED` authority event.
- [ ] Run `bun test tests/integration/identity`; expected initial failure is missing persistence behavior, then PASS after implementation.
- [ ] Add strict OIDC and authenticated-proxy adapters and tests for issuer, audience, signature, state, nonce, trusted origin path, identity linking, and invitation-only membership.
- [ ] Add device pairing, rotating refresh credentials, sender-constrained access proof, CSRF, and container-only host recovery tests.
- [ ] Add browser journey for two owners, passkey/recovery, and removal; run `bun run test:e2e -- setup-and-members.spec.ts` and expect PASS.

**Security drill:** Replay invitation and recovery secrets; use expired tokens; race two last-owner demotions; remove an actor with active sessions and an unused attempt permit. Every credential and permit is rejected after the committed membership revision.

## Task Group 2: Projects, local discovery, and architectural dependency guard

**Requirements:** `FND-003`; owns `ORP-09` and part of `ORP-12`.

**Files:**

- Create `src/server/modules/projects/{contract,project-registry}.ts`.
- Create `src/shared/contracts/projects.ts`.
- Create `src/runner/repository/{config,discovery,global-registry}.ts`.
- Create `src/server/db/migrations/0002_projects.sql` and verifier; add authoritative Project base branches without inventing values for unexpected old rows.
- Create `src/cli/commands/{init,projects,status}.ts`.
- Create `tests/unit/architecture/dependency-direction.test.ts`.
- Test `tests/unit/projects/`, `tests/integration/projects/`, `tests/integration/cli-projects.test.ts`.

**Test-first sequence:**

- [ ] Write failing parser tests for exact team/project/server keys, upward discovery, duplicate path mapping, path traversal rejection, and outside-repository global lookup.
- [ ] Implement `.collab/config.toml` and `~/.collab/global.db` adapters; absolute paths remain local.
- [ ] Write the dependency-direction test to scan imports and reject adapter-to-adapter and domain-to-adapter edges.
- [ ] Run `bun test tests/unit/projects tests/unit/architecture tests/integration/cli-projects.test.ts`; expect PASS.

**Failure drill:** Corrupt local registry, move the checkout, and supply a config for another deployment. CLI reports a structured local diagnostic and never rewrites server project identity implicitly.

## Task Group 3: Runner pairing, sharing, data plane, hosts, runtimes, and diagnostics

**Requirements:** `FND-004`, `FND-005`, `FND-012`, `FND-015`, `FND-018`; owns `ORP-02` and `ORP-11`.

**Files:**

- Create `src/server/db/migrations/0003_runners.sql` and verifier.
- Create `src/server/modules/runners/{contract,runner-registry,exposures}.ts`.
- Create `src/server/adapters/wss/{protocol,runner-channel,revocations}.ts`.
- Create `src/runner/{daemon,supervisor,local-diagnostics}.ts`.
- Create `src/runner/adapters/runtime/{contract,claude,codex}.ts`.
- Create `src/runner/adapters/host/{contract,native,orca}.ts`.
- Create `src/runner/adapters/enforcement/{contract,trusted-host}.ts`.
- Test `tests/protocol/runner-data-plane.test.ts`, `tests/integration/runners/`, `tests/runner/conformance/`.

**Test-first sequence:**

- [ ] Define protocol fixtures and failing tests for schema validation, assignment/audience, replay, expiry, backpressure, heartbeat, message size, and allowlisted operations.
- [ ] Implement outbound WSS transport using typed frames only; run `bun test tests/protocol/runner-data-plane.test.ts` to green.
- [ ] Add one shared runtime conformance suite and execute it unchanged against Claude and Codex adapters.
- [ ] Add one host conformance suite and execute it unchanged against Native and Orca adapters in both modes.
- [ ] Prove trusted-host enforcement always reports `ADVISORY`; a request requiring `ENFORCED` is ineligible.
- [ ] Add exposure acknowledgement/version tests and cross-owner dispatch/revocation tests.
- [ ] Add encrypted local-tail byte/age/re-authentication tests and prove no payload crosses WSS.

**Security drill:** Send an executable path, shell command, environment, raw terminal control sequence, private profile query, stale exposure, and revoked pairing credential. Each is rejected or safely rendered without process start or durable secret storage.

## Task Group 4: Run lifecycle, authority, presets, context, telemetry, and worktrees

**Requirements:** `FND-006`–`FND-011`, `FND-016`, `FND-017`; owns `ORP-04`, `ORP-05`, and `ORP-10` implementation prerequisites.

**Files:**

- Create `src/server/db/migrations/0004_runs_authority.sql` and verifier.
- Create `src/shared/contracts/{runs,execution-authority,presets,context,telemetry}.ts`.
- Create `src/server/modules/runs/{lifecycle,checkpoints,evidence,results}.ts` as private `ExecutionAuthority` implementation modules.
- Create `src/server/modules/coordination-records/{canonical-key,registry,source-links}.ts` with minimal source-free records and mutation-guard ownership.
- Create `src/server/modules/execution-authority/{contract,execution-authority,policy,fencing,revocation}.ts`.
- Create `src/server/modules/presets/{personal-run-presets,configuration-resolver}.ts`.
- Create `src/server/modules/context/context-recipes.ts` and `src/server/modules/telemetry/usage.ts`.
- Create `src/runner/repository/{worktrees,publish,cleanup}.ts`.
- Test `tests/unit/runs/`, `tests/unit/execution-authority/`, `tests/integration/runs/`, `tests/integration/execution-authority/`, `tests/runner/worktrees.test.ts`.

**Test-first sequence:**

- [ ] Write transition-table tests for Agent Run and Attempt states, including immutable terminal attempts and `LOST -> run WAITING`.
- [ ] Write property tests for single-use permits, monotonic fences, exact revisions, policy epochs, minimum assurance, and idempotent commands.
- [ ] Implement `AUTHORIZE_ATTEMPT` as one transaction that creates the `PENDING` attempt and permit only after all checks pass.
- [ ] Implement activation, renewal, operation authorization, release, and revocation with stable error codes.
- [ ] Test preset snapshot immutability and reference-only bounded Context Recipe assembly.
- [ ] Test `UNKNOWN`/partial telemetry without cost inference.
- [ ] Test worktree reuse, cross-run separation, published-reference verification, safe cleanup, retained local work, and owner-only discard.
- [ ] Run `bun test tests/unit/runs tests/unit/execution-authority tests/integration/runs tests/integration/execution-authority tests/runner/worktrees.test.ts`; expect PASS.

**Failure drill:** Replay permits, race policy updates, change base revision, submit stale fences, lose runner during each nonterminal state, dirty the worktree, fail push verification, and fail cleanup. No history is rewritten and no work is discarded silently.

## Task Group 5: Equivalent web, CLI, MCP, and live projections

**Requirements:** `FND-014`; closes `ORP-03` and `ORP-12`.

**Files:**

- Create `src/server/adapters/http/routes/{projects,runs,runners,presets}.ts`.
- Create `src/server/adapters/mcp/{server,tools}.ts` and `src/cli/commands/mcp.ts` for the local stdio bridge.
- Create `src/server/adapters/http/sse.ts`.
- Create `src/cli/commands/{start,cancel,resume,runner,preset}.ts`.
- Create `src/web/features/{runs,runners,presets}/`.
- Test `tests/protocol/surface-parity.test.ts`, `tests/e2e/foundation-run.spec.ts`.

**Test-first sequence:**

- [ ] Create a table-driven contract fixture for create/inspect/cancel/resume and map it through HTTP, CLI, and MCP adapters.
- [ ] Assert identical domain values and error codes; adapters may differ only in presentation and transport metadata.
- [ ] Implement thin adapters calling `ExecutionAuthority`, `RunnerRegistry`, and preset modules.
- [ ] Run `bun test tests/protocol/surface-parity.test.ts`; expect PASS.
- [ ] Run browser and CLI source-free run journeys; expect the same run/attempt identities and committed SSE projection.

**Architecture drill:** The dependency-direction test must fail if MCP imports SQLite, connectors, WSS, web code, or policy implementations.

## Task Group 6: Offline safety, cancellation, and bounded recovery

**Requirements:** `FND-008`, `FND-009`; completes `ORP-10`.

**Files:**

- Consume immutable `src/server/db/migrations/0005_foundation_operations.sql` and verifier; do not edit either file.
- Create `src/runner/db/migrations/0006_continuity_cache.sql`; runner migrations 0001 through 0005 remain immutable.
- Create `src/runner/{cache,outbox,offline-policy}.ts`.
- Create `src/server/modules/runs/{event-deduplication,reconciliation}.ts`.
- Create `tests/drills/network-partition.test.ts`, `tests/drills/cancellation.test.ts`, `tests/drills/runner-loss.test.ts`.

**Test-first sequence:**

- [ ] Use a fake clock and controllable transport to test inspect-only continuation and mutating grace expiry separately.
- [ ] Assert disconnected runners cannot renew leases, publish, mutate connectors, or claim transitions.
- [ ] Replay ordered and duplicate outbox events after reconnect; committed state changes exactly once.
- [ ] Cancel while connected, disconnected, starting, and running; record confirmed versus unconfirmed disposition honestly.
- [ ] Run `bun test tests/drills/network-partition.test.ts tests/drills/cancellation.test.ts tests/drills/runner-loss.test.ts`; expect PASS.

## Task Group 7: Backup/restore and sustained dogfood gate

**Requirements:** `FND-013`, `FND-019`; closes `ORP-13`.

**Files:**

- Create `src/server/operations/{backup,restore,key-rotation}.ts`.
- Create `src/server/commands/{backup,restore,key-rotation,auth-recover}.ts` and a `collab-server` command dispatcher included in the server artifact.
- Create `tests/drills/backup-restore.test.ts`, `tests/drills/offboarding-active-run.test.ts`.
- Create evidence template `docs/evidence/foundation/EVIDENCE-TEMPLATE.md` and dogfood ledger `docs/evidence/foundation/DOGFOOD-LEDGER.md` during implementation.

**Test-first sequence:**

- [ ] Test authenticated backup, key identifier, wrong/missing key, schema mismatch, isolated restore, session invalidation, epoch increment, and connector review state.
- [ ] Test offboarding dispatcher and runner owner during active work, including unreachable runner and preserved local-work truth.
- [ ] Run the full verification suite and both drills.
- [ ] Operate the exact build for seven consecutive days; record every run, incident, migration, restart, restore, and whether direct database editing occurred.

## Composition-root and packaging ownership

Each task group updates its feature modules only. One integration owner wires `src/server/app.ts`, `src/server/index.ts`, `src/cli/command.ts`, `src/cli/index.ts`, `src/web/app.tsx`, `src/shared/environment.ts`, `package.json`, `Dockerfile`, and `compose.yaml` after the corresponding interface tests pass. Compose adds public base URL, WebAuthn RP ID, deployment master-key input, backup destination, and one-time bootstrap-secret handling. `bun run test` includes unit, integration, protocol, runner, and drill suites so the package gate cannot omit a class of tests.

## Verification commands

```bash
bun run format:check && bun run lint && bun run typecheck
bun test tests/unit tests/integration tests/protocol tests/runner tests/drills
bun run build && bun run test:e2e
```

Expected: all exit 0. Also execute the runner conformance matrix on two trusted machines and the isolated restore drill from a copied encrypted backup.

## Canonical Product Spec exit criterion

> Exit when both owners can start headless and interactive Claude or Codex attempts on their own trusted machines from web and CLI; exact permit replay and stale-policy cases fail; a lost runner produces run `WAITING` plus attempt `LOST`; server backup and isolated restore drills pass; and one week of dogfood produces no need for direct database repair.

## Phase exit gate

- `FND-001` through `FND-019` are `PASS` with evidence.
- The canonical criterion above is retained unchanged in evidence.
- Both runtimes and all Native/Orca × Headless/Interactive combinations are proven, removing the ambiguity of “or.”
- Cross-owner exposure, MCP parity, offline mutation grace, diagnostic tail, and offboarding drills pass.
- No direct SQLite repair occurred during the dogfood window.

## Rollback boundary

If Foundation cannot pass, stop before connector credentials exist. Restore the authenticated pre-phase empty deployment backup, revoke runner pairings, remove generated local worktrees only through owner-confirmed cleanup, and preserve the failed build's evidence without copying sensitive runtime output.
