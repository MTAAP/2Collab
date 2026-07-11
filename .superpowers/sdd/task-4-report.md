# Task 4 Implementation Report

## Scope

Implemented Foundation Task 4 only: browser sessions and CSRF, device authorization and DPoP,
OIDC/auth-proxy provider verification and links, offline host recovery, member role/offboarding
revocation, envelope-encrypted credential storage, generic source/context connector contracts,
crash-safe ConnectorAuthority intents/reconciliation, the shared mutation vocabulary, and complete
schema-v1 persistence for those primitives. No GitHub or Outline provider-specific repository,
project, document, GraphQL, URL, payload, or external-call implementation was added.

## RED

Initial focused command:

```text
bun test tests/unit/connectors tests/integration/connectors tests/integration/identity/providers.test.ts tests/integration/identity/devices.test.ts tests/integration/identity/offboarding.test.ts tests/drills/offboarding-active-run.test.ts
```

Observed result: exit 1; 0 pass, 6 fail. Every focused file failed because its Task 4 identity or
connector module did not exist.

Two correction cycles were also proven red before implementation:

- body-safe context connector and credential-owner AAD tests: 0 pass, 2 fail
- bounded ephemeral search page contract: 0 pass, 1 fail
- injected connector confirmation rollback: 6 pass, 1 fail, demonstrating the missing rollback hook

## GREEN

Focused identity, connector, drill, and migration command:

```text
bun test tests/unit/connectors tests/integration/connectors tests/integration/identity tests/drills/offboarding-active-run.test.ts tests/integration/db/foundation-migration.test.ts
```

Final observed result: exit 0; 60 pass, 0 fail, 312 assertions. The bounded ephemeral search
contract's focused file passed with 5 pass, 0 fail.

The final full repository test run passed:

- unit: 69 pass, 0 fail, 299 assertions
- integration: 60 pass, 0 fail, 315 assertions
- combined: 129 pass, 0 fail

## Implemented invariants

- Browser sessions persist only bearer/CSRF digests, bind the current Member authority epoch, use a
  12-hour idle and seven-day absolute limit, rotate atomically, and derive Member identity from the
  HTTP-only application cookie. CSRF separately checks exact configured origin, closed mutation
  methods, safe content types, and the session-bound proof.
- Device codes/access expire after ten minutes. Refresh families use 30-day idle and 90-day absolute
  limits, rotate sender-bound credentials, and revoke the family on old-token replay. DPoP checks the
  exact method, normalized URI, nonce, sender thumbprint, token hash, five-minute clock window, and
  atomic ten-minute replay record.
- OIDC state and nonce are server-minted, hash-only, ten-minute, exact-redirect-bound, and single-use.
  Provider configuration owns issuer/audience/client/redirect expectations. Auth-proxy provenance is
  created only after direct-peer, forwarded-origin, assertion, issuer/audience/time, and durable
  replay checks; no public origin-trust boolean exists.
- Verified provider identity links only to an authenticated active Member or the verified-identity
  half of a live invitation exchange. Matching email is never used for membership or linking.
- Host recovery is constructible only in offline-container mode with the mounted bootstrap secret,
  selects an existing active OWNER, stores only a ten-minute one-time code hash, and emits categorical
  host audit records.
- Offboarding checks the owner actor and last-active-owner invariant under `BEGIN IMMEDIATE`, revokes
  membership, passkeys/provider credentials, sessions, device families/access, and member-owned
  encrypted credentials, advances the Member epoch, and commits a durable idempotent revocation
  outbox record before calling ExecutionAuthority. Dispatch failure leaves retryable committed state.
- Connector mutations use the closed `ABSENT | EXACT_REVISION | EXPECTED_MEMBERSHIP` precondition,
  explicit project/connector/epoch/reference/operation scope, one action digest, and the settled
  GitHub/Outline operation vocabulary.
- A generic STRICT operation intent is `PENDING` before any provider call. Confirmation atomically
  commits normalized provider reference/revision/provenance, a strict codec-approved projection,
  audit, idempotency, and intent state. Restart recovery uses only an exact reference or deterministic
  non-secret marker. Ambiguity fails permanently; epoch/scope drift requires explicit
  reauthorization.
- `ContextConnector` live reads and search snippets use distinct `EphemeralObserved` and bounded
  `EphemeralSearchPage` envelopes. ConnectorAuthority has no API accepting them. Persisted
  projections must pass an injected strict bounded codec.
- Credential encryption AAD binds row ID, class, owner kind/ID, connector ID, credential-owner/grant
  row ID, key version, and revision. Encryption/decryption remains outside synchronous SQLite
  transactions, with exact revision revalidation after asynchronous crypto.

## Verification

Successful final commands:

```text
bun ci
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bunx playwright install chromium
bun run test:e2e:run
docker build --tag 2collab:verify .
git diff --check
```

Results:

- Bun 1.3.10 frozen install: no changes
- format: 88 files checked, clean
- lint: 89 files checked, clean
- typecheck: exit 0
- tests: 129 pass, 0 fail
- web/server/compiled CLI build: exit 0
- Playwright Chromium smoke: 1 pass, 0 fail
- Docker image build: exit 0
- Docker Compose config with an explicit verification-only `SESSION_SECRET`: exit 0
- diff check: exit 0

Verification limits unrelated to Task 4 code:

- `bun run audit:public` reports the pre-existing Task 1 absolute-path rejection canaries in
  `.superpowers/sdd/task-1-report.md` and `tests/unit/architecture/task-1-contract-review.test.ts`.
- `bun run manifest:verify` reports the branch's existing untracked SDD artifacts and all current
  source/test files as inventory extras; the release manifest was not regenerated because generated
  release state is outside this task.
- the first `docker compose config --quiet` invocation lacked the required `SESSION_SECRET`; the
  environment-bound rerun is recorded separately.

## Self-review

- No asynchronous provider, crypto, hashing, or ExecutionAuthority call occurs inside a synchronous
  SQLite transaction. Every async boundary snapshots exact revisions and rechecks them under the
  final immediate transaction.
- Provider errors and exceptions map to stable categorical errors. Raw codes, assertions, bearer
  values, refresh/access tokens, CSRF proofs, provider payloads, query snippets/bodies, environment
  values, and decrypted credentials are not written to audit, idempotency, projections, or logs.
- Task 3's public-record-ID plus one-time-proof session invariant remains intact; new browser sessions
  add a separate CSRF proof without turning record IDs into credentials.
- Tests use deterministic clocks, IDs, hashes, barriers/state transitions, and fake connectors. The
  crash-safe connector suite covers restart before local confirmation, injected confirmation
  rollback, revocation before recovery, marker ambiguity, same-input replay, changed-input conflict,
  strict projection serialization, and run-independent reconciliation.
