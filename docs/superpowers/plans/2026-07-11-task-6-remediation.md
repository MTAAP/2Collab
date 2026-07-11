# Task 6 Runner Authority Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every verified finding in `.superpowers/sdd/task-4-6-final-review.md` without changing Task 7/8 remediation or Task 9 run-authority behavior.

**Architecture:** Keep device and runner authentication at branded-principal boundaries, but make issuance depend on one final current-state transaction. Centralize Task 6 write idempotency/audit around the runner registry, revalidate all exposure authority facts inside immediate transactions, privacy-gate non-owner eligibility before projecting private data, and make the v3 verifier prove canonical schema behavior while preserving the later v4 verifier.

**Tech Stack:** Bun 1.3.10, TypeScript, Zod, `bun:sqlite`, Bun tests.

## Global Constraints

- Use one root Bun toolchain and exact existing dependency versions.
- Write every regression test first and observe its expected failure.
- Keep user-facing errors stable and bounded; never persist or echo secrets.
- Do not edit Task 7/8 remediation files or Task 9 modules/tests.
- Do not stage `src/server/db/migrate.ts` until the Task 9 commit lands; preserve its v4 verifier.

---

### Task 1: Device principal compatibility and exact expiry

**Files:**
- Modify: `src/shared/contracts/actors.ts`
- Modify: `src/server/modules/runners/runner-registry.ts`
- Modify: `tests/integration/runners/runner-fixture.ts`
- Test: `tests/integration/runners/pairing.test.ts`

**Interfaces:**
- Consumes: `createDeviceAuthority.verifyAccess(...).value`.
- Produces: `VerifiedDevicePrincipal` carrying `accessExpiresAt: number` and accepted by `beginPairing` only while `clock() < accessExpiresAt`.

- [ ] Add a test that passes the real device-authority result directly to `beginPairing`, then advances to exact expiry and expects `RUNNER_PAIRING_INVALID`.
- [ ] Run `bun test tests/integration/runners/pairing.test.ts` and confirm RED at strict parsing/expiry.
- [ ] Add `accessExpiresAt` to the principal and strict pairing schema, and enforce exact expiry.
- [ ] Rerun the pairing test and confirm GREEN.

### Task 2: Authentication race closure and bounded replay state

**Files:**
- Modify: `src/server/modules/runners/authentication.ts`
- Test: `tests/integration/runners/authentication.test.ts`
- Test: `tests/integration/runners/concurrency.test.ts`

**Interfaces:**
- Consumes: verified DPoP result and in-memory access claim.
- Produces: `VerifiedRunnerPrincipal` only after current runner, credential, owner-member epoch/status, and replay insertion succeed in one immediate transaction.

- [ ] Add deterministic revoke and member-offboarding interleaving tests plus expired-claim/replay cleanup and sender-scoped JTI tests.
- [ ] Run the two focused files and confirm RED because stale principals are returned and state is not collected/scoped.
- [ ] Move asynchronous proof hashing before the final transaction; purge expired rows/claims, digest thumbprint plus JTI, and atomically revalidate credential/member/runner facts with replay insertion.
- [ ] Rerun both focused files and confirm GREEN.

### Task 3: Atomic exposure authority and private eligibility

**Files:**
- Modify: `src/server/modules/runners/runner-registry.ts`
- Test: `tests/integration/runners/concurrency.test.ts`
- Test: `tests/integration/runners/privacy.test.ts`
- Test: `tests/integration/runners/exposures.test.ts`

**Interfaces:**
- Consumes: current browser actor, runner owner/epoch/audience, mapping, latest profile, policy/security tuple, and acknowledgement.
- Produces: acknowledgements/exposures/revocations committed only with current authority; non-owners receive one indistinguishable denial for missing/private/revoked/unexposed combinations.

- [ ] Add interleaving tests that revoke/offboard immediately before acknowledgement, exposure, and revocation writes, and privacy tests for revoked/private exposure equality.
- [ ] Run focused exposure/concurrency/privacy tests and confirm RED.
- [ ] Recompute every authority fact and write inside `inImmediateTransaction`; gate non-owner eligibility on current TEAM audience plus exact active exposure/ack/mapping/latest profile before loading/projecting private facts.
- [ ] Rerun focused tests and confirm GREEN.

### Task 4: Runner write idempotency and audit

**Files:**
- Modify: `src/shared/contracts/runners.ts`
- Modify: `src/server/modules/runners/runner-registry.ts`
- Modify: `tests/integration/runners/runner-fixture.ts`
- Test: `tests/integration/runners/registry.test.ts`
- Test: `tests/integration/runners/revocation.test.ts`

**Interfaces:**
- Consumes: `idempotencyKey`, authenticated actor/principal, canonical secret-safe input hash, expected revision where applicable.
- Produces: same-key/same-input safe replay, `IDEMPOTENCY_KEY_REUSED` on changed input, secret-issued markers rather than clear secrets, and atomic `audit_events` preserving initiating actor and immutable runner owner.

- [ ] Add contract and integration tests for every Task 6 public write, same-key replay, changed-input conflict, secret absence, expected revision, audit actor/owner, and rollback atomicity.
- [ ] Run focused registry/revocation tests and confirm RED because commands lack the envelope and tables remain empty.
- [ ] Add the command fields and a runner-specific idempotency/audit boundary used by pairing, mapping, profile, acknowledgement, exposure, heartbeat, and direct revoke writes.
- [ ] Rerun focused tests and confirm GREEN.

### Task 5: Exact v3 verification and migration integration

**Files:**
- Modify: `src/server/db/migrations/0003_runners.verify.ts`
- Modify after Task 9 commit: `src/server/db/migrate.ts`
- Test: `tests/integration/db/runners-migration.test.ts`

**Interfaces:**
- Consumes: migrated schema version 3 or later.
- Produces: verifier rejection for altered columns/FKs/checks/index predicates/trigger bodies and acceptance of canonical v3 followed by canonical v4.

- [ ] Add drift tests for a no-op owner trigger, weakened tuple FK/check, non-partial active index, and altered column.
- [ ] Run the migration tests and confirm RED against the current name-only verifier.
- [ ] Verify normalized canonical v3 DDL/digests, exact `table_xinfo`/FK/index metadata, trigger bodies, and behavioral owner immutability.
- [ ] After Task 9 commits, reconcile `migrate.ts` so both v3 and v4 verifiers run; rerun migration tests and confirm GREEN.

### Task 6: Full verification and intentional commit

**Files:** all Task 6 remediation files above only.

- [ ] Run all runner integration and v3 verifier tests.
- [ ] Run `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run build`.
- [ ] Inspect `git diff`/`git status`, exclude concurrent Task 7/8 and Task 9 paths, stage only Task 6 remediation, and commit with a focused message.
