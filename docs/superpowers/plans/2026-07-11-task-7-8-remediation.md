# Task 7 and 8 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every confirmed finding in `.superpowers/sdd/task-7-8-review.md` with production-composed, bounded, replay-safe runner transport and crash-safe local supervision.

**Architecture:** Keep the shared directional schemas structural, then place stateful receiver/lifecycle objects at each connection edge. Keep server transport composition behind injected Bun upgrade/socket seams and keep local process, output, environment, and diagnostics policy owned by focused runner modules. No Task 9 migration or coordination/execution-authority module is modified.

**Tech Stack:** Bun 1.3.10, TypeScript strict mode, Bun WebSocket server/client APIs, Zod, `bun:sqlite`, Bun test, Biome.

## Global Constraints

- Write and observe each focused regression failing before changing production behavior.
- Use only the root Bun 1.3.10 toolchain and exact pinned dependencies.
- Keep runner secrets, local paths, environment values, transcripts, and interactive bytes out of shared storage and protocol diagnostics.
- Do not modify server migration `0004`, `src/server/modules/coordination-records`, `src/server/modules/execution-authority`, or `tests/integration/runs`.
- Preserve concurrent uncommitted Task 9 work and stage only Task 7/8 files.

---

### Task 1: Stateful server-envelope receiver in the real runner client

**Files:**
- Modify: `tests/protocol/runner-client.test.ts`
- Modify: `src/runner/transport/wss-client.ts`

**Interfaces:**
- Consumes: selected protocol version, injected `now`, closed `ServerEnvelopeSchema`.
- Produces: one serialized `onEnvelope` chain with strict time/order/replay enforcement.

- [ ] Add client regressions that send stale, 31-second-future, excessive-lifetime, sequence-regressed, exact-replay, and changed-replay envelopes, plus two async handlers whose second effect must not begin before the first resolves.
- [ ] Run `bun test tests/protocol/runner-client.test.ts` and observe the review reproductions fail.
- [ ] Add an injected clock, a 30-second future allowance, a finite maximum lifetime, connection-scoped `(messageId, sequence, digest)` replay state, strict increasing sequence, and a promise-chain receiver. Exact replay has no second effect; every invalid frame closes with bounded protocol reason.
- [ ] Re-run the client test and the protocol codec/ordering tests to green.

### Task 2: Crash-safe supervisor authority and one environment policy

**Files:**
- Modify: `tests/runner/supervisor.test.ts`
- Modify: `tests/runner/local-state.test.ts`
- Modify: `tests/runner/environment.test.ts`
- Modify: `src/runner/supervisor.ts`
- Modify: `src/runner/process-state.ts`
- Modify: `src/runner/environment.ts`

**Interfaces:**
- Consumes: injected clock and builder-owned `validate(environment)` policy.
- Produces: resumable exact reservations, explicit failed-start/release transitions, deadline checks before permit and start.

- [ ] Add regressions proving expired work consumes no permit and starts no host; expiry after permit prevents start; transient permit failure can retry; host-start failure records `FAILED_TO_START`; exact no-process reservation resumes while changed digests fail; configured credential bindings pass the supervisor.
- [ ] Run the three focused suites and observe the current poison/deadline/allowlist behavior fail.
- [ ] Extend the local process state machine so exact `RESERVED` rows are resumable, retryable pre-start failures release atomically or remain safely resumable, and terminal host-start failures become `FAILED_TO_START`; retain assignment-digest conflict denial.
- [ ] Inject `clock`; check `deadlineAt <= now` before enforcement/reservation/permit and immediately before host start; ensure a deadline failure after permit records a failed start and never calls the host.
- [ ] Make the environment builder expose the only validation policy and remove the supervisor hardcoded name set while retaining bounded names/values.
- [ ] Re-run focused supervisor/local-state/environment tests to green.

### Task 3: Diagnostic expiry and disable lifecycle

**Files:**
- Modify: `tests/runner/local-diagnostics.test.ts`
- Modify: `src/runner/local-diagnostics.ts`

**Interfaces:**
- Produces: `disable(correlationId, ownerMemberId, proof)` plus expiry-aware metadata that best-effort purges payload.

- [ ] Add regressions for the exact expiry boundary, metadata-triggered purge, authenticated owner disable, non-owner/failed-reauth denial, and post-disable append denial.
- [ ] Run the diagnostic suite and observe missing disable and stale enabled metadata failures.
- [ ] Implement owner-reauthenticated disable as deletion (or a disabled tombstone without payload), make metadata purge expired rows and return `DIAGNOSTIC_EXPIRED`, and reuse the same expiry transition in append/reveal.
- [ ] Re-run diagnostics to green.

### Task 4: Obligatory redacted headless producer and bounded live output

**Files:**
- Create: `src/runner/headless-output.ts`
- Create: `tests/runner/headless-output.test.ts`
- Modify: `tests/protocol/runner-output.test.ts`
- Modify: `src/server/adapters/wss/live-output.ts`

**Interfaces:**
- Produces: `createHeadlessOutputProducer({send})` with independent stdout/stderr redactors, bounded chunks, monotonically increasing stream sequences, and termination flush.
- Produces: `LiveOutputHub` ceilings for retained text, items, and replay metadata.

- [ ] Add an integration regression that pushes split tokens/private-key blocks through the real producer into outbound `HEADLESS_OUTPUT_CHUNK` bodies, proves stream separation and flush, and proves no interactive producer API.
- [ ] Add empty/many-small-chunk hub regressions and verify current storage grows beyond the configured ceiling.
- [ ] Implement the producer around one `SplitSafeRedactor`, split emitted UTF-8 into at most 16 KiB protocol chunks, bound pending output, and flush both streams exactly once at process termination.
- [ ] Account for conservative per-chunk metadata, cap target/process item counts, and remove replay entries when chunks leave the fixed replay window; preserve regression detection via last sequence.
- [ ] Re-run redaction/output suites to green.

### Task 5: Integrated channel lifecycle, limits, acknowledgements, and quiesce

**Files:**
- Modify: `src/shared/contracts/protocol.ts`
- Modify: `src/server/adapters/wss/protocol.ts`
- Modify: `src/server/adapters/wss/runner-channel.ts`
- Modify: `src/server/adapters/wss/rate-limits.ts`
- Modify: `tests/protocol/runner-handshake.test.ts`
- Modify: `tests/protocol/runner-limits.test.ts`
- Modify: `tests/protocol/runner-ordering.test.ts`
- Create: `tests/protocol/runner-lifecycle.test.ts`

**Interfaces:**
- Produces: welcome limits for per-run rate/burst, send queue items/bytes, output/reconnect ceilings.
- Produces: connection lifecycle with hello timeout, heartbeat idle close, per-run buckets, bounded send queue, semantic-ack deadline, and deadline-aware quiesce cleanup.

- [ ] Add exact 30/31-second skew and maximum-lifetime regressions; welcome-limit schema regressions; hello 10-second, heartbeat/offline 30-second, per-run 50/100 rate, 1,024 item/1 MiB queue, 10-second ack, and quiesce-deadline regressions.
- [ ] Run focused protocol tests and observe each missing integration fail.
- [ ] Tighten runner-frame time validation and expose a reusable connection lifecycle driven by injected scheduler functions; all timers cancel on close/quiesce.
- [ ] Integrate `BoundedSendQueue` in `createRunnerChannel`; resolve timed-out/quiesced receipts retryably without deleting durable pending operations; enforce per-run buckets using body attempt/gate IDs.
- [ ] Clear live output and queues during quiesce, close with 1012, and stop accepting upgrades/dispatch before waiting only until the supplied deadline.
- [ ] Re-run focused protocol tests to green.

### Task 6: Real Bun WSS upgrade adapter and production composition

**Files:**
- Create: `src/server/adapters/wss/bun-runner-control.ts`
- Create: `tests/protocol/runner-bun-adapter.test.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/app.ts` only if the Hono fallback route must explicitly deny non-upgrade `/runner/v1` requests.

**Interfaces:**
- Consumes: `createRunnerUpgradeAuthenticator`, stateful protocol channel, inbound router, runner channel, heartbeat/output/semantic ports.
- Produces: `BunWssRunnerControlAdapter` fetch upgrade handler plus Bun `websocket` callbacks; `InMemoryRunnerControlAdapter` conformance fixture uses the same lifecycle contract.

- [ ] Verify Bun 1.3.10 `server.upgrade(request, {data, headers})` and `websocket` handler signatures from primary documentation.
- [ ] Add adapter conformance regressions proving authentication completes before upgrade, failed auth never calls upgrade, authenticated data reaches hello/router, binary/compressed/oversized input closes, and socket close detaches the exact fence.
- [ ] Run the adapter test and observe the missing module/composition failure.
- [ ] Implement a deep adapter with injected Bun server upgrade seam and socket wrapper; keep tokens/proofs out of data/log/close reasons and authenticate exact HTTPS GET before `upgrade`.
- [ ] Compose the adapter in `src/server/index.ts` without importing Task 9 modules; dependencies are injected or fail closed until application composition supplies authorities.
- [ ] Run all Task 7/8 suites, then broad non-Task-9 format/lint/typecheck/test/build gates.
- [ ] Stage only Task 7/8 files, inspect the staged patch, and commit focused remediation commits.
