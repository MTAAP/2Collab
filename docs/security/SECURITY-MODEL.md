> **Authority level:** Derived explanation; does not add or amend product behavior.  
> **Canonical source:** [`PRODUCT-SPEC.md`](../product/PRODUCT-SPEC.md). If this document conflicts with the Product Spec, the Product Spec wins.

# Security Model

## Overview and canonical anchors

2Collab is a self-hosted coordination system for one trusted development team. Its server is internet-reachable in some deployments, holds coordination and connector credentials, and can authorize processes on trusted developer-controlled runners. The runner executes as its operating-system user and may inherit powerful local git, GitHub, and agent-provider credentials. That combination makes authentication, execution authorization, revocation, exact revisions, and honest assurance labels the primary security concerns.

This model derives from:

- [`System Role and Authority`](../product/PRODUCT-SPEC.md#system-role-and-authority)
- [`Connector Authority and Revocation V1`](../product/PRODUCT-SPEC.md#connector-authority-and-revocation-v1)
- [`Authentication Architecture V1`](../product/PRODUCT-SPEC.md#authentication-architecture-v1)
- [`Break-Glass Owner Recovery V1`](../product/PRODUCT-SPEC.md#break-glass-owner-recovery-v1)
- [`Local Passkey Authentication V1`](../product/PRODUCT-SPEC.md#local-passkey-authentication-v1)
- [`Team Invitations V1`](../product/PRODUCT-SPEC.md#team-invitations-v1)
- [`Team Roles V1`](../product/PRODUCT-SPEC.md#team-roles-v1)
- [`Member Offboarding and Authority Revocation V1`](../product/PRODUCT-SPEC.md#member-offboarding-and-authority-revocation-v1)
- [`Work Item Mutation Guard V1`](../product/PRODUCT-SPEC.md#work-item-mutation-guard-v1)
- [`Execution Authority and Runner Exposure V1`](../product/PRODUCT-SPEC.md#execution-authority-and-runner-exposure-v1)
- [`Local Interactive Security Boundary V1`](../product/PRODUCT-SPEC.md#local-interactive-security-boundary-v1)
- [`Project Discovery and Auth`](../product/PRODUCT-SPEC.md#project-discovery-and-auth)
- [`Runner Registration and Web Launch`](../product/PRODUCT-SPEC.md#runner-registration-and-web-launch)
- [`Secure Runner Data Plane`](../product/PRODUCT-SPEC.md#secure-runner-data-plane)
- [`Offline Safety Boundary`](../product/PRODUCT-SPEC.md#offline-safety-boundary)
- [`Server Persistence and Operations`](../product/PRODUCT-SPEC.md#server-persistence-and-operations)

This is a repository-wide design model, not a list of current vulnerabilities.

## Assets and security objectives

| Asset | Security objective |
|---|---|
| Team membership and roles | Only invited, authenticated Members participate; privileged changes require current `OWNER` authority and required reauthentication; never zero owners |
| Browser, CLI, MCP, runner, recovery, and refresh sessions | Prevent theft, replay, cross-audience use, fixation, and continued use after revocation |
| Connector credentials and delegated grants | Never expose to browsers, CLIs, agents, runners, logs, or backups without encryption; limit use to configured scopes and current epochs |
| Runner identity and Team Dispatch Exposures | Prevent unauthorized execution, stale-policy use, exposure widening, and confusion between dispatcher and machine owner |
| Developer credentials and local profiles | Keep runner-local; never transmit executable paths, arguments, environment, or credentials through the server |
| Worktrees and unpublished work | Preserve owner control; prevent accidental sharing, migration claims, destructive cleanup, and concurrent mutation under stale authority |
| Coordination state and provenance | Preserve atomicity, idempotency, immutable terminal history, exact actor attribution, and authoritative revisions |
| Approval Subjects, gates, permits, sessions, and leases | Prevent replay, confused-deputy use, stale-revision use, and authority widening |
| GitHub and Outline content | Respect provider authority, connected scopes, exact revisions, identity attribution, and revocation |
| Raw output, prompts, source bodies, diffs, and local diagnostics | Minimize collection, redact before transport, bound retention, and prevent unauthorized disclosure |
| SQLite volume, backups, and deployment master key | Preserve confidentiality, integrity, recoverability, and non-resurrection of revoked authority |

## Actors and assumptions

### Trusted or operator-controlled actors

- A deployment operator controls the server container, Compose environment, persistent volume, backup destination, master key, and host-level recovery command.
- Team `OWNER` members administer authentication, connectors, invitations, membership, projects, and deployment security settings.
- A runner owner controls their machine, local profiles, developer credentials, worktrees, and decision to expose exact mapping/profile versions to the Team.
- An active `MEMBER` is trusted for day-to-day collaboration across every Project, including supported source mutations, approvals, delegation, and explicitly Shared Runners.

### Attacker-controlled or untrusted inputs

- Internet HTTP requests, cookies, origins, headers, query parameters, request bodies, MCP messages, SSE connection attempts, and webhook deliveries.
- Invitation and recovery-code redemption attempts.
- OIDC responses and identity-proxy headers until cryptographically and contextually verified.
- GitHub and Outline webhook payloads, provider responses, source text, filenames, labels, comments, document content, and revisions.
- Runner WSS frames until authenticated, schema-validated, replay-checked, and matched to current runner/attempt state.
- Agent runtime stdout, stderr, structured events, suggested links, Markdown, control sequences, paths, result claims, and evidence references.
- Repository content, including `.collab/config.toml`, instructions, manifests, symlinks, filenames, and gate definitions.
- Browser-rendered source content and bounded live output.

### Security assumptions

- The server host, runner operating systems, container runtime, OS credential stores, and TLS trust stores are maintained by their operators.
- Native and Orca runners are trusted-machine supervisors, not container sandboxes.
- `ADVISORY` assurance cannot prevent arbitrary local code from using ambient owner credentials or editing outside the managed worktree.
- GitHub and Outline may change after 2Collab's final revision check when their provider operation lacks atomic conditional mutation. Reconciliation, not a false serializability claim, closes that residual race.
- A malicious server host or malicious runner operating-system owner is outside the protection offered by application-level encryption and policy on that same host.
- A separate client, company, or trust group requires another deployment. V1 does not promise tenant isolation inside one process or database.

## Trust boundaries

### Internet client to `collab-server`

All browser and remote MCP access crosses authentication, authorization, request validation, CSRF where applicable, rate, size, and output-encoding controls. Network reachability through localhost, LAN, Tailscale, Cloudflare, or another proxy is never identity. There is no `AUTH_DISABLED` mode.

### Identity provider or authentication proxy to internal Member

`LOCAL`, `OIDC`, and `AUTH_PROXY` verification end at an immutable internal Member identifier. Email equality never auto-links identities. OIDC validates issuer, audience, signature, expiry, state, and nonce. Cloudflare Access assertions require cryptographic verification. Tailscale identity headers are trusted only when the origin cannot be reached except through the configured local proxy path.

### `collab-server` to GitHub and Outline

The server holds connector credentials and calls providers through narrow adapters. Provider permissions, selected repositories/projects/collections, project scopes, connector epochs, and exact resource revisions jointly limit operations. Agents and runners receive references and capabilities, never connector credentials.

### `collab-server` to Registered Runner

The runner initiates outbound-only authenticated WSS. Messages are a closed typed set with identifiers, audience, issue/expiry times, replay protection, size/rate limits, heartbeat, idle timeout, bounded reconnect, and backpressure. No inbound listener, arbitrary executable, remote shell, terminal input, environment dump, or credential transport exists.

### Runner supervisor to local process

The runner resolves an opaque local profile, supplies a dedicated worktree and minimal local environment, and supervises the process tree. The process and repository content remain untrusted producers of output and requests. `ADVISORY` authority coordinates behavior but cannot isolate a hostile process from the runner owner's ambient machine access. `ENFORCED` may be claimed only by an adapter that technically prevents the prohibited operations.

### Interactive terminal to shared system

Interactive keystrokes, PTY bytes, prompts and responses, attachment handles, control sequences, terminal history, and transcripts remain local. The server exposes status and semantic controls only. Encryption of WSS does not permit terminal proxying.

### SQLite and backup to deployment key

Connector and refresh credentials use envelope encryption under a master key supplied outside the SQLite volume and backup destination. Backups contain ciphertext, integrity metadata, schema version, and key identifier. Restore verifies integrity and compatibility in isolation before listeners open, then invalidates sessions/capabilities and increments connector/runner epochs.

## Threats, controls, and failure disposition

| Threat | Required controls | Failure disposition |
|---|---|---|
| Unauthenticated deployment claim | One-time bootstrap secret available only through local Compose environment or server logs; expire permanently after first-owner creation | Deny claim without valid secret; never regenerate through an unauthenticated request |
| Account takeover | WebAuthn passkeys with user verification, exact origin/RP ID, one-time recovery codes stored as salted hashes, fresh passkey verification for promotion/demotion | End affected sessions and audit recovery or privileged action |
| OIDC/proxy spoofing | Validate cryptography and expected issuer/audience/origin path; map only to prelinked immutable Member identity | Deny session creation; never join Team from upstream identity alone |
| Invitation theft or replay | High-entropy single-use secret in URL fragment; protected POST exchange; hashed token; short expiry; invitation-only session | Expiry, revocation, or use invalidates invitation permanently |
| CSRF or browser session abuse | Secure HTTP-only session, CSRF protection, origin rules, privileged reauthentication, escaped rendering | Reject state-changing request and audit high-risk failures |
| Cross-project or synthetic tenant bypass | One deployment Team, server-derived Team identity, team-wide Project access, explicit Project IDs and connector scopes; no caller-selected tenant routing | Reject invalid Project/scope; never invent project ACL semantics |
| Unauthorized runner dispatch | Immutable runner owner, `OWNER_ONLY` default, exact Team Dispatch Exposure, versioned acknowledgement, active Member, heartbeat, epoch, mapping/profile/policy revision checks | `WAITING` or `DENIED`; no process and no attempt-budget charge before committed attempt |
| Permit theft, replay, or stale policy | Signed short-lived single-use audience-bound permit; atomic consumption immediately before process creation; sender, runner, epoch, revision, expiry, and revocation checks | Reject with stable code; duplicated frames cannot start another process |
| Stale or widened Authority Session | Short expiry, monotonic fence, renewal against current state, operation-level exact-revision authorization | Deny renewal/operation; request checkpoint/termination when authority is revoked |
| Concurrent mutation | One mutation reservation per Coordination Record by default; short live lease per active attempt; exact branch uniqueness; explicit audited override only | Deny or wait; expired lease stops further mutation/publish/external writes after bounded grace |
| Misleading inspect-only or sandbox claim | `INSPECT_ONLY` receives no 2Collab mutation/publish/connector capability; runner reports worktree changes; assurance displayed as `ADVISORY` or `ENFORCED` | Record violation; never auto-promote or label advisory execution sandboxed |
| Approval or gate replay | Immutable Approval Subject with exact SHAs/revisions/digests; gate manifest from trusted base; owner-approved fingerprint; exact-revision Gate Evaluation | Return `APPROVAL_STALE` or reject gate; never widen authority |
| Connector scope escape or stale credential | Versioned connector epochs, configured allowlists, exact revision check before each operation, server-held credentials, provider reconciliation | Deny affected operations; move required work to `WAITING`; never auto-apply old proposals |
| Member offboarding race | Transactional membership revocation, Member epoch increment, session/device/permit/capability/grant/approval invalidation, runner revocation | Request terminate-and-checkpoint; record only `CONFIRMED` stop or eventual `LOST` from evidence |
| Command or shell injection | Server sends only typed operations and opaque profile/gate references; runner resolves fixed local argument arrays; no shell; prompt transported separately | Reject schema/profile conflict before process start as `FAILED_TO_START` |
| Path traversal or symlink escape | Canonical repository mapping, opaque worktree identifier, normalized repository-relative protocol paths, rejection of absolute/parent/control-character paths; enforced adapters add technical isolation when required | Reject frame or operation and retain safe diagnostic correlation |
| Malicious terminal or source output | Local redaction, bounded chunks, sequence numbers, escaped terminal rendering, unsafe-link and control-sequence rejection | Drop/reject unsafe output; store only bounded safe evidence |
| Secret leakage through telemetry or persistence | Explicit allowlists, redaction before transmission, no raw prompt/source/environment/credential persistence, interactive transcript local-only, diagnostics opt-in/encrypted/bounded | Omit unsafe data; expose correlation identifiers rather than local configuration |
| Webhook spoofing, replay, or reordering | Provider signature verification, delivery identifiers, timestamp/freshness policy, idempotency, reconciliation | Reject invalid delivery; deduplicate valid repeats; provider remains authoritative |
| SSRF through connector or content references | Connector calls remain inside configured provider adapters and owner-selected scopes; source content and agent output cannot introduce arbitrary transport operations | Deny unsupported target or operation; do not add a generic HTTP workflow node |
| Denial of service | Request/frame/output size limits, per-run and per-runner rate limits, bounded concurrency, deadlines, heartbeat/idle timeouts, backpressure, bounded reconnect/backoff | Throttle, reject, time out, or mark attempt `LOST` without widening authority |
| Backup theft or rollback | Envelope encryption, external master key, authenticated backup manifest, restore isolation, schema check, epoch increments, connector review | Refuse unauthenticated/incompatible restore; old backup cannot resurrect revoked authority |
| Destructive worktree cleanup | Runner-owner authorization, explicit confirmation, clean/published proof for automatic cleanup, no server-side worktree contents | Retain local work on uncertainty; only runner owner may discard |

## Revocation model

Revocation denies future authority before attempting process termination. Credential invalidation is not proof that arbitrary code stopped.

```ts
type TerminationDisposition = "REQUESTED" | "CONFIRMED" | "LOST";
```

- Member removal, run cancellation, deadline expiry, runner revocation, and repository-authority revocation invalidate future operations and request checkpoint plus termination.
- Connector scope reduction increments epochs, revokes unused permits and queued connector writes, and removes only affected connector operations. Unrelated local work may continue.
- Team audience or exposure revocation blocks unused permits and future attempts. The runner owner separately chooses whether to stop an already-running valid session.
- An unreachable process remains unconfirmed and follows the normal grace policy to `LOST`.
- Adoption after offboarding creates a newly authorized follow-up from a Published or Recoverable Remote Reference. It inherits no approval, grant, permit, personal preset, credential, or runner-local state.

## Data minimization and retention

Durable shared data may include authored instruction parts, bounded attached previews, lifecycle events, safe progress summaries, decisions, approved excerpts, exit status, verification evidence, hashes, source references, and audit metadata.

Durable shared data must not include raw terminal output, interactive transcripts, flattened prompts, fetched source bodies, raw diffs, environment dumps, developer credentials, connector tokens, private profile arguments, local absolute paths, or worktree contents.

Headless output is live-only by default. A bounded in-memory reconnect buffer is permitted during the active attempt. Runner-owner diagnostics are opt-in, encrypted locally, capped by age and bytes, disabled by default for interactive sessions, and never synchronized to the server.

## Security invariants

1. Every request acts as a concrete authenticated Member, scheduler acting for an original dispatcher, or authenticated runner identity.
2. Reachability is never authorization; no `AUTH_DISABLED` mode exists.
3. Product `OWNER`, runner owner, dispatcher, source identity, and 2Collab Bot Identity are distinct actors.
4. Team membership does not expose a runner. A Shared Runner exposes only exact acknowledged project-mapping/profile versions.
5. Every agent process requires one fresh consumed Dispatch Permit and one live fenced Authority Session.
6. Every attempt-originated mutating or external operation requires current Authority Session and exact resource revision immediately before action; ordinary human connector operations still require current Member and connector authority.
7. `INSPECT_ONLY` and `ADVISORY` never imply sandbox enforcement.
8. No previous approval, permit, session, epoch, grant, profile, or workflow step implicitly authorizes later work.
9. Interactive terminal input never crosses the server.
10. The server never supplies arbitrary local execution details.
11. External providers remain authoritative and are reconciled after residual races.
12. Restore never resurrects revoked sessions, permits, runner identity, or connector authority.

## Required security tests

### Authentication and membership

- Passkey registration and login reject wrong origin, RP ID, challenge, user-verification state, credential, and replayed assertion.
- OIDC rejects wrong issuer, audience, signature, state, nonce, expiry, and unlinked subject.
- Authentication-proxy verification rejects unsigned assertions, wrong audience/issuer, forwarded headers from an untrusted origin path, and Funnel traffic without another login method.
- Invitation exchange proves fragment handling, token hashing, short expiry, single use, revocation, and inability to create a session or Team membership before identity verification.
- Recovery codes are shown once, stored only as hashes, single use, expiry-bound where specified, and cannot create or elevate Members.
- Promotion/demotion requires fresh passkey verification; final-owner removal/demotion fails transactionally.
- Browser mutations reject missing/invalid CSRF protection and stale/revoked sessions.

### Execution authority and runner transport

- Identical idempotent launch produces one run, attempt, permit, and WSS outbox record; conflicting reuse fails.
- Concurrent permit consumption proves exactly one success.
- Permit tests cover expiry, wrong audience, wrong runner connection, replay, malformed signature, epoch movement, policy change, and post-issue revocation.
- Authority Session tests cover expiry, monotonic fence, stale renewal, cancellation, deadline, Member revocation, connector revocation, runner revocation, and mutation-lease loss.
- Concurrent `MUTATING` launch tests prove one guard reservation and lease without explicit override.
- Offline tests prove `MUTATING` stops gaining authority after lease/grace expiry while `INSPECT_ONLY` may continue only to its attempt deadline.
- `INSPECT_ONLY` never receives mutate, publish, connector-write, or destructive-cleanup authority.
- `ENFORCED` requests reject advisory-only runners; UI-safe explanation always identifies `ADVISORY` honestly.
- WSS tests reject unauthenticated, expired, duplicate, out-of-order, oversized, rate-exceeding, mismatched-runner, and unknown-operation frames.
- Typed runner commands cannot contain shell strings, executable paths, caller-controlled working directories, environment values, credentials, or terminal input.
- Reconnect and duplicate delivery cannot regress attempt/session state or launch a second process.

### Connector and revision authority

- GitHub and Outline adapters reject operations outside selected scopes and with stale connector epochs or resource revisions.
- Connector scope reduction first increments epochs and denies new operations, then invalidates queued writes and affected capabilities.
- Approval tests invalidate on head, dirty state, evidence, gate, configuration, and source-revision changes.
- Gate tests reject a manifest from the agent-modified worktree, unapproved fingerprint, wrong repository mapping, stale head, shell invocation, absolute working directory, and mutation of tracked content.
- Webhook tests cover invalid signatures, replayed delivery identifiers, out-of-order events, missed delivery reconciliation, and idempotent application.
- External-write race tests preserve a visible residual-race result and reconcile provider truth rather than claiming a serializable commit.

### Input, output, and local execution

- Protocol schemas reject absolute paths, parent traversal, control characters, non-canonical separators, oversized path sets, and unknown fields where the schema is closed.
- Prompt transport tests prove shell-looking text remains literal input and cannot become arguments or shell syntax.
- Browser rendering escapes HTML and terminal control sequences and rejects unsafe links from source or agent output.
- Redaction tests cover common authorization headers, tokens, passwords, and private keys before live transmission.
- Interactive tests prove PTY input/output and attachment handles never enter WSS frames, Durable Outbox, SQLite, backups, or browser transports.
- Cleanup tests prove automatic removal requires no active attempt, clean tracked/untracked state, and verified remote reachability; only runner owner can discard retained work.

### Persistence, backup, and restore

- SQLite integration tests prove launch/revocation transactions do not leave partial permits, leases, grants, approvals, or outbox intents.
- Connector credentials are encrypted at rest and absent from ordinary logs, error bodies, diagnostics, and backups in plaintext.
- Backup verification rejects altered ciphertext, invalid authentication tag, missing key identifier, and incompatible schema.
- Restore runs without network listeners, requires the supplied master key, invalidates server sessions/capabilities, increments connector/runner epochs, and holds queued external mutations until owner review.
- Restoring an older valid backup cannot make a previously revoked permit, capability, runner, Member session, or connector operation valid.

## Severity calibration

### Critical

- Unauthenticated remote command execution on a runner or arbitrary server-to-runner shell dispatch.
- Remote extraction of deployment master key, connector credentials, or runner-owner developer credentials at broad scope.
- Authentication bypass that grants deployment `OWNER` authority or permits first-owner claim without the bootstrap secret.

### High

- Cross-Member dispatch to an unexposed runner/profile or permit replay that starts another process.
- Stale Authority Session or connector epoch permitting repository publish, GitHub mutation, or Outline overwrite after revocation.
- Passkey, OIDC, proxy, invitation, or recovery flaw enabling durable Member takeover.
- Server-stored interactive transcript or large-scale raw prompt/source leakage contrary to the persistence contract.

### Medium

- CSRF on a meaningful but recoverable Member operation without credential disclosure.
- Stored XSS confined to authenticated Team views without direct credential or runner execution impact.
- Failure to redact bounded live output, path metadata leakage, or audit omission with limited scope.
- Denial of service against scheduler, SSE, or one runner that does not cross authority boundaries.

### Low

- Safe diagnostic detail or metadata exposure without secrets, source content, execution authority, or meaningful privacy impact.
- Rate-limit or availability weakness limited to a local trusted operator path.
- UI-only assurance wording defect when no operation is enabled and the actual authority decision remains correct; systematic false sandbox claims are more severe.

Severity depends on realistic reachability, required actor control, affected runner/source scope, persistence, and whether the defect crosses an authority boundary. Findings that require a malicious server host to defeat policy enforced only by that same host, or a malicious runner owner to access their own local credentials, are normally outside the application threat model unless they create impact on other Members or external sources.
