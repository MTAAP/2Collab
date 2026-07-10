# 2Collab V1 Acceptance Matrix

> **Authority: Derived implementation guidance.** The canonical product authority is the [Product Spec](../product/PRODUCT-SPEC.md). If this matrix conflicts with the Product Spec, the Product Spec wins and this matrix must be corrected before implementation continues.

This matrix turns the four Product Spec dogfood slices into stable, observable requirements. A requirement passes only when its proof is captured from running software; schema presence, mocked UI, and unexecuted code do not count.

## Status vocabulary

- `NOT_STARTED`: no accepted implementation evidence.
- `IN_PROGRESS`: implementation exists but the observable proof is incomplete.
- `BLOCKED`: an external or earlier-phase dependency prevents proof; the blocker is named.
- `PASS`: the exact observable proof is attached to the phase evidence record.
- `FAIL`: runtime evidence contradicts the requirement.

Every evidence record contains the repository revision, build identifier, command or user journey, test result, relevant audit/event identifiers, and reviewer.

## Foundation requirements

| ID | Canonical Product Spec anchor | Requirement | Observable exit proof | Test level | Failure meaning |
|---|---|---|---|---|---|
| `FND-001` | [Single-Team Deployment V1](../product/PRODUCT-SPEC.md#single-team-deployment-v1) | Empty deployment bootstrap creates exactly one team and one initial owner. | Start with an empty data volume, complete bootstrap, authenticate, and inspect the durable team/member audit event. | E2E + restore fixture | Deployment identity is ambiguous or bootstrap is repeatable. |
| `FND-002` | [Team Invitations V1](../product/PRODUCT-SPEC.md#team-invitations-v1) | Invitations, passkey enrollment, owner promotion/demotion, member removal, recovery, and the last-owner invariant are complete. | A bootstrap owner invites a member, promotes them, both authenticate, recovery succeeds, removal revokes sessions, and removing or demoting the last owner is rejected transactionally. | Integration + browser E2E + security drill | The two-owner dogfood team cannot be created or safely offboarded. |
| `FND-003` | [Project Discovery and Auth](../product/PRODUCT-SPEC.md#project-discovery-and-auth) | One source-free project is registered and discoverable inside its repository and through the global registry. | Web and CLI resolve the same project ID from `.collab/config.toml` and from outside the repository without leaking absolute paths to the server. | Unit + integration + CLI E2E | Project identity or locality is inconsistent. |
| `FND-004` | [Runner Registration and Web Launch](../product/PRODUCT-SPEC.md#runner-registration-and-web-launch) | Each owner can pair an owner-only runner with an explicit project mapping. | Two owners pair distinct runners; cross-owner dispatch fails; revoked and stale pairing credentials fail. | Integration + protocol test | Machine ownership or mapping authority is bypassable. |
| `FND-005` | [Execution Host and Interaction Axes V1](../product/PRODUCT-SPEC.md#execution-host-and-interaction-axes-v1) | Claude and Codex execute through Native and Orca in both `HEADLESS` and `INTERACTIVE`. | The evidence matrix contains both runtimes and all four host-by-mode combinations; interactive terminal bytes remain local. | Runner conformance + manual dogfood | A promised runtime/host/mode combination is not real or local interaction escapes. |
| `FND-006` | [Personal Run Presets V1](../product/PRODUCT-SPEC.md#personal-run-presets-v1) | Personal Run Presets and source-free `ONCE` runs resolve to immutable effective configuration. | Save, launch, edit the preset, and prove the historical run retains original preset/profile versions and authored input. | Integration + browser/CLI E2E | Historical execution configuration can drift. |
| `FND-007` | [Execution Authority and Runner Exposure V1](../product/PRODUCT-SPEC.md#execution-authority-and-runner-exposure-v1) | Attempt authorization is atomic, single-use, revision-bound, fenced, and honest about `ADVISORY` versus `ENFORCED`. | Replay, expiry, stale policy/mapping/profile, stale fence, and inadequate assurance cases fail with stable codes and never start a process. | Property + integration + protocol security | Unauthorized or duplicate execution can occur. |
| `FND-008` | [Execution Attempt Lifecycle V1](../product/PRODUCT-SPEC.md#execution-attempt-lifecycle-v1) | Agent Run and Execution Attempt lifecycles remain distinct and recover honestly. | Kill a runner mid-process; attempt becomes `LOST`, run becomes `WAITING`, and explicit resume creates a new attempt without rewriting history. | Integration + fault injection | Process evidence is confused with goal state. |
| `FND-009` | [Offline Safety Boundary](../product/PRODUCT-SPEC.md#offline-safety-boundary) | Checkpoints, cancellation, bounded offline continuation, mutation-lease expiry, and outbox replay are safe. | Disconnect inspect-only and mutating attempts; mutation stops after grace, reconnect deduplicates ordered events, and no raw output enters the outbox. | Integration + network fault drill | Offline execution can silently acquire or extend authority. |
| `FND-010` | [Agent Run Worktree Ownership V1](../product/PRODUCT-SPEC.md#agent-run-worktree-ownership-v1) | One run reuses one worktree across attempts; separate runs never share mutable work. | Retry/resume preserves an opaque worktree identity; concurrent runs get distinct worktrees and branches. | Runner integration | Durable goals can corrupt each other's local state. |
| `FND-011` | [Agent Run Worktree Ownership V1](../product/PRODUCT-SPEC.md#agent-run-worktree-ownership-v1) | Published Git References and cleanup rules preserve dirty or unpublished work. | Clean published work auto-removes; dirty, untracked, unpublished, and cleanup-failure cases remain retained; only runner owner can discard. | Runner integration + destructive-action drill | Local work can be lost or retained indefinitely without owner control. |
| `FND-012` | [Secure Runner Data Plane](../product/PRODUCT-SPEC.md#secure-runner-data-plane) | Runner transport is outbound-only, typed, replay-resistant, bounded, and secret-minimizing. | Protocol suite rejects arbitrary commands, invalid assignments, stale/oversized frames and revoked credentials; storage scan finds no raw prompt, transcript, environment, credential, or local path. | Protocol conformance + storage scan | The server becomes a remote shell or durable secret sink. |
| `FND-013` | [Server Persistence and Operations](../product/PRODUCT-SPEC.md#server-persistence-and-operations) | SQLite backup, authenticated restore, key separation, epoch invalidation, and reauthorization work. | Isolated restore verifies integrity before listeners open, rejects wrong key, invalidates sessions/capabilities, increments epochs, and cannot resurrect revoked permits. | Operational restore drill | Recovery weakens revocation or loses the deployment. |
| `FND-014` | [Agent Run Command Surface V1](../product/PRODUCT-SPEC.md#agent-run-command-surface-v1) | Web, CLI, and MCP expose the same semantic run operations without duplicating policy. | Contract tests execute create, inspect, cancel, resume, and evidence reads through all three adapters and compare canonical results/errors. | Contract + E2E | One surface has hidden authority or incompatible semantics. |
| `FND-015` | [Execution Authority and Runner Exposure V1](../product/PRODUCT-SPEC.md#execution-authority-and-runner-exposure-v1) | Team Dispatch Exposures are exact, acknowledged, revocable, and do not enumerate private profiles. | One owner exposes one mapping/profile version; another member dispatches only that pair; exposure revocation blocks future attempts and preserves the declared current-attempt disposition. | Integration + authorization security | Team access widens a runner beyond owner intent. |
| `FND-016` | [Context Recipes and On-Demand Retrieval V1](../product/PRODUCT-SPEC.md#context-recipes-and-on-demand-retrieval-v1) | Generic reference-first Context Recipes are versioned, bounded, and grant no authority. | Launch contains identifiers/revisions and bounded previews only; changing a recipe affects future runs, not historical snapshots. | Unit + integration + storage scan | Context assembly becomes unbounded or authority-bearing. |
| `FND-017` | [Best-Effort Usage Telemetry V1](../product/PRODUCT-SPEC.md#best-effort-usage-telemetry-v1) | Attempt/runtime/gate duration and provenance record `UNKNOWN` and coverage honestly. | Mix structured and unavailable usage reports; UI/API show partial coverage and never infer zero, cost, or model service proof. | Unit + integration | Operational data becomes fabricated billing data. |
| `FND-018` | [Secure Runner Data Plane](../product/PRODUCT-SPEC.md#secure-runner-data-plane) | Optional encrypted local diagnostic tail is owner-only, bounded by age and bytes, and never synchronized. | Enable, cap, expire, reauthenticate to reveal locally, and confirm server sees metadata only; interactive capture is disabled by default. | Runner security drill | Sensitive runtime output becomes shared or unbounded. |
| `FND-019` | [Dogfood Delivery Slices and Exit Criteria](../product/PRODUCT-SPEC.md#dogfood-delivery-slices-and-exit-criteria) | Foundation operates for one week without direct SQLite repair. | Versioned dogfood log names build, runs, incidents, migrations, backup/restore result, and records zero manual database edits. | Sustained dogfood | Foundation is not operationally self-sufficient. |

## GitHub coordination requirements

| ID | Canonical Product Spec anchor | Requirement | Observable exit proof | Test level | Failure meaning |
|---|---|---|---|---|---|
| `GHB-001` | [Deployment Model](../product/PRODUCT-SPEC.md#deployment-model) | GitHub App permissions and repository selection form a hard scope ceiling. | Allowed repository works; unselected repository cannot be projected or mutated even if organization discovery sees it. | Connector contract + security E2E | Connector reach exceeds owner selection. |
| `GHB-002` | [GitHub Issues V1 Role](../product/PRODUCT-SPEC.md#github-issues-v1-role) | Issue and pull-request projections reconcile from GitHub without becoming authoritative copies. | Drop a webhook; periodic reconciliation converges to GitHub state with freshness and provenance. | Integration + webhook fault drill | Collab fabricates or permanently stales source state. |
| `GHB-003` | [GitHub Issue Mutation Surface V1](../product/PRODUCT-SPEC.md#github-issue-mutation-surface-v1) | Supported mutations confirm externally and use exact revision compare-and-set for replace-style edits. | Exercise create/edit/comment/labels/assignees/milestone/state; stale edits conflict and refresh rather than overwrite. | Connector contract + live sandbox E2E | Concurrent GitHub edits can be lost or locally fabricated. |
| `GHB-004` | [GitHub Milestones V1](../product/PRODUCT-SPEC.md#github-milestones-v1) | Milestone operations retain GitHub authority. | Create/edit/close/reopen and assign/unassign a real milestone; reconciled state and counts match GitHub. | Integration + live sandbox | Planning metadata diverges. |
| `GHB-005` | [GitHub Projects V1](../product/PRODUCT-SPEC.md#github-projects-v1) | Selected GitHub Projects enforce Project-by-repository intersection. | Allowed item fields mutate; an item from another repository remains redacted and immutable. | Integration + scope security | Organization Projects permission leaks unrelated content. |
| `GHB-006` | [Assignment and Delegation V1](../product/PRODUCT-SPEC.md#assignment-and-delegation-v1) | Assignment and Delegation are separate, independently auditable operations. | Force success/failure in both partial-success directions; neither successful action rolls back or masquerades as the other. | Integration + E2E | Human accountability and execution provenance collapse. |
| `GHB-007` | [Universal Coordination Record V1](../product/PRODUCT-SPEC.md#universal-coordination-record-v1) | Project/source identity resolves to one canonical Coordination Record, including late linking. | Start source-free, link issue/PR later, race duplicate links, and prove one record with unchanged run history. | Transaction/concurrency integration | Work history fragments or duplicates. |
| `GHB-008` | [Source-Agnostic Agent Run Creation V1](../product/PRODUCT-SPEC.md#source-agnostic-agent-run-creation-v1) | Delivery uses closing references but waits for GitHub-reported closure. | Publish and merge a PR; disabled auto-close remains open and is shown honestly until GitHub reports closure. | Live sandbox E2E | Collab invents source completion. |
| `GHB-009` | [Work Item Mutation Guard V1](../product/PRODUCT-SPEC.md#work-item-mutation-guard-v1) | Mutation guards, explicit overrides, target-branch collision, and advisory changed-path collisions are distinct. | Same-record mutator is blocked absent override; independent overlapping runs warn but continue; override is audited. | Concurrency integration | Parallelism is either unsafe or unnecessarily serialized. |
| `GHB-010` | [Diff Evidence and Review Policy V1](../product/PRODUCT-SPEC.md#diff-evidence-and-review-policy-v1) | Diff evidence is bounded and raw diffs are not persisted. | Inspect base/head, path/stat and verification evidence; storage scan finds no source diff. | Integration + storage scan | Source code is duplicated into coordination storage. |
| `GHB-011` | [Repository-Defined Quality Gates V1](../product/PRODUCT-SPEC.md#repository-defined-quality-gates-v1) | GitHub check observation is bound to the exact Published Git Reference. | A passing check for the old SHA becomes stale after head change and cannot satisfy current evidence. | Integration + live sandbox | Verification applies to the wrong revision. |
| `GHB-012` | [Advisory Source Dependencies V1](../product/PRODUCT-SPEC.md#advisory-source-dependencies-v1) | Dependencies warn with freshness and authoritative links but never block or mutate run lifecycle. | Exercise unresolved, stale, unavailable and resolved states; launch remains possible and later changes do not pause/complete the run. | Integration + E2E | Advisory source data becomes hidden workflow authority. |
| `GHB-013` | [Source Membership Alignment V1](../product/PRODUCT-SPEC.md#source-membership-alignment-v1) | Connector narrowing and member offboarding deny new GitHub operations immediately. | Narrow repository/Project scope and remove a member during a run; unused capability and affected operation fail with stable revocation evidence. | Security integration | Removed authority remains usable. |
| `GHB-014` | [Notification Inbox V1](../product/PRODUCT-SPEC.md#notification-inbox-v1) | Inbox and Command Center are derived, deduplicated, and non-authoritative. | Trigger waiting, collision, terminal, review, and connector events; personal read state works and board cards cannot write lifecycle. | Integration + browser E2E | UI becomes a second task system. |
| `GHB-015` | [Dogfood Delivery Slices and Exit Criteria](../product/PRODUCT-SPEC.md#dogfood-delivery-slices-and-exit-criteria) | A real connected issue reaches authoritative delivery end to end. | Evidence covers triage, assignment, delegation, implementation, publish with closing reference, review, merge, observed closure, missed webhook, stale edit, late link, and scope narrowing. | Live dogfood | GitHub coordination does not reach delivery honestly. |

## Outline collaboration requirements

| ID | Canonical Product Spec anchor | Requirement | Observable exit proof | Test level | Failure meaning |
|---|---|---|---|---|---|
| `OUT-001` | [Outline V1 Role](../product/PRODUCT-SPEC.md#outline-v1-role) | Delegated member OAuth and bot-authored agent operations remain distinct. | Two members authenticate; human edits show native member attribution; agent edits show bot attribution plus exact run provenance. | Connector contract + live sandbox | Attribution or authority is misleading. |
| `OUT-002` | [Outline V1 Role](../product/PRODUCT-SPEC.md#outline-v1-role) | Context Read Scopes constrain search and reads despite wider connector credentials. | Allowed documents appear; out-of-scope identifiers and bodies do not. | Security integration | Connector credentials bypass project scope. |
| `OUT-003` | [Federated Search V1](../product/PRODUCT-SPEC.md#federated-search-v1) | Search/read is live, reference-first, and does not centrally ingest bodies. | Storage retains identifiers, revisions and provenance only after real search/read. | Integration + storage scan | Context source becomes a hidden warehouse. |
| `OUT-004` | [Outline V1 Role](../product/PRODUCT-SPEC.md#outline-v1-role) | Direct human edits use exact revision preconditions. | Two members race an edit; stale save creates a conflict and never overwrites current content. | Connector contract + browser E2E | Concurrent knowledge edits are lost. |
| `OUT-005` | [Outline V1 Role](../product/PRODUCT-SPEC.md#outline-v1-role) | A grant binds one run to exact named documents and non-destructive operations. | Repeated in-grant edits pass; another document, run, destructive action, expiry, or revoked grant fails. | Property + integration | Agent document authority widens silently. |
| `OUT-006` | [Outline V1 Role](../product/PRODUCT-SPEC.md#outline-v1-role) | External edits during a proposal produce an immutable conflict proposal. | Change the document externally between propose/apply; original proposal remains inspectable and cannot overwrite. | Integration + live sandbox | Proposal application loses external work. |
| `OUT-007` | [Outline V1 Role](../product/PRODUCT-SPEC.md#outline-v1-role) | Working documents are optional canvases, not canonical merely because an agent wrote them. | Create/link/edit one and prove neither existence nor run completion promotes its authority. | Integration | Temporary artifacts become false project truth. |
| `OUT-008` | [Connector Authority and Revocation V1](../product/PRODUCT-SPEC.md#connector-authority-and-revocation-v1) | Member, bot, connector, and grant revocation block new external operations with explicit disposition. | Revoke each during pending/active work; no stale grant resumes and audit identifies the cause. | Security + fault integration | Revoked document authority persists. |
| `OUT-009` | [Secure Runner Data Plane](../product/PRODUCT-SPEC.md#secure-runner-data-plane) | Raw document bodies do not enter logs, coordination tables, backups, or runner outboxes. | Exercise a unique canary through search/read/edit/conflict/offline flows; scan all prohibited stores. | Data-loss prevention drill | Sensitive knowledge leaks into durable operational storage. |
| `OUT-010` | [Dogfood Delivery Slices and Exit Criteria](../product/PRODUCT-SPEC.md#dogfood-delivery-slices-and-exit-criteria) | Two-member bidirectional Outline dogfood succeeds. | Evidence covers co-edit attribution, exact grant iteration, external conflict, member/bot revocation, and body-storage scan. | Live dogfood | Outline collaboration is read-only, unsafe, or falsely attributed. |

## Bounded automation requirements

| ID | Canonical Product Spec anchor | Requirement | Observable exit proof | Test level | Failure meaning |
|---|---|---|---|---|---|
| `AUT-001` | [Team Run Templates V1](../product/PRODUCT-SPEC.md#team-run-templates-v1) | Team Run Templates are portable, versioned, and contain no local commands or credentials. | Bind one template to two Personal Run Presets; template edits affect only future runs. | Unit + integration | Shared intent leaks private configuration or rewrites history. |
| `AUT-002` | [Visual Workflow Authoring V1](../product/PRODUCT-SPEC.md#visual-workflow-authoring-v1) | Workflow Definition is canonical and Canvas Layout cannot change execution. | Layout-only edits preserve semantic version; transition/contract edits create a new version. | Unit + browser E2E | View geometry becomes executable policy. |
| `AUT-003` | [Automated Run Workflows V1](../product/PRODUCT-SPEC.md#automated-run-workflows-v1) | Validation rejects missing terminal/fix paths, unsafe joins, unbounded cycles, and parallel mutating steps. | Negative fixture suite returns stable diagnostics before publication. | Property + unit | Invalid automation can be activated. |
| `AUT-004` | [Team Workflow Templates and Personal Workflow Presets V1](../product/PRODUCT-SPEC.md#team-workflow-templates-and-personal-workflow-presets-v1) | Every agent step has an explicit compatible personal binding. | Distinct runtimes/models/runners/hosts/modes execute; stale/missing binding pauses without substitution. | Integration + E2E | Workflow silently chooses execution authority. |
| `AUT-005` | [Workflow Execution Lifecycle V1](../product/PRODUCT-SPEC.md#workflow-execution-lifecycle-v1) | Workflow events create distinct linked Agent Runs exactly once. | Restart coordinator and replay duplicate transitions; exactly one run exists per step under one record. | Concurrency/fault integration | Restart or retry duplicates work. |
| `AUT-006` | [Automated Run Workflows V1](../product/PRODUCT-SPEC.md#automated-run-workflows-v1) | Parallel groups contain only `INSPECT_ONLY` runs and joins consume typed results. | Claude and Codex reviews run concurrently; `ALL`/`ANY` matches policy and no transition parses prose. | Integration | Parallel mutation or prose parsing corrupts control flow. |
| `AUT-007` | [Workflow Execution Lifecycle V1](../product/PRODUCT-SPEC.md#workflow-execution-lifecycle-v1) | Human gates are durable and never park an agent process. | Reach decision, prove all processes exited, restart, decide, and observe the correct next run. | Fault integration + E2E | Human latency consumes live execution or loses state. |
| `AUT-008` | [Diff Evidence and Review Policy V1](../product/PRODUCT-SPEC.md#diff-evidence-and-review-policy-v1) | Conditional Fix runs launch only from typed review results. | Major finding triggers Fix; clean/minor-only reaches terminal; missing result follows declared fallback. | Integration | Automation infers control flow from untrusted prose. |
| `AUT-009` | [Repository-Defined Quality Gates V1](../product/PRODUCT-SPEC.md#repository-defined-quality-gates-v1) | Gates use trusted-base manifests, owner-approved fingerprints, named sets, and exact revisions. | Self-modified manifest, stale fingerprint, transmitted command, wrong revision, and tracked-file mutation fail. | Runner conformance + security | A run can redefine or bypass its verifier. |
| `AUT-010` | [Managed Loop Stop Policies V1](../product/PRODUCT-SPEC.md#managed-loop-stop-policies-v1) | Managed Loops require semantic stop, positive attempt bound, and absolute deadline. | Exercise achieved, attempt exhaustion, deadline, failed start, and lost attempt; every created attempt counts. | Property + fault integration | Automation can become unbounded. |
| `AUT-011` | [Workflow Execution Lifecycle V1](../product/PRODUCT-SPEC.md#workflow-execution-lifecycle-v1) | Pause, waiting, restart, and revocation never reset or extend deadlines. | Pause past deadline, restart, revoke authority, replay events; no extra attempt launches. | Time-controlled fault integration | Administrative delay grants extra automation. |
| `AUT-012` | [Portable Planning Workflows V1](../product/PRODUCT-SPEC.md#portable-planning-workflows-v1) | Planning produces typed Plan Artifacts and optional durable approval without universal plan-mode flags. | Plan with one runtime, approve/reject, implement with another; schema contains no runtime-specific plan flag. | Integration + E2E | Planning is coupled to one CLI or hidden process memory. |
| `AUT-013` | [Best-Effort Usage Telemetry V1](../product/PRODUCT-SPEC.md#best-effort-usage-telemetry-v1) | Workflow aggregation preserves partial coverage and separates gate time. | Mixed known/unknown child metrics produce labelled partial totals with gate duration separate. | Unit + integration | Workflow usage totals are misleading. |
| `AUT-014` | [Dogfood Delivery Slices and Exit Criteria](../product/PRODUCT-SPEC.md#dogfood-delivery-slices-and-exit-criteria) | The canonical implementation-review-fix workflow is authored and executed end to end. | Create materially in React Flow and execute `Implementation -> parallel Claude and Codex review -> conditional Fix -> Terminal` on a real PR; duplicate/restart/deadline/no-park proofs pass. | Live dogfood | Workflow complexity has not demonstrated value safely. |

## Product Spec V1 decision coverage

| Product Spec decision | Owning requirements |
|---|---|
| Git Worktree Isolation | `FND-010`, `FND-011` |
| Durable Agent Run Checkpoints | `FND-008`, `FND-009` |
| Advisory Source Dependencies | `GHB-012` |
| Automatic Run Workflows | `AUT-002`–`AUT-008`, `AUT-014` |
| Policy-Driven Diff Review | `GHB-010`, `AUT-007`, `AUT-008` |
| Repository-Defined Quality Gates | `GHB-011`, `AUT-009` |
| Personal Run Presets and Explicit Selection | `FND-006` |
| Reference-First Context Recipes | `FND-016`, `GHB-002`, `OUT-003` |
| Team Run Templates | `AUT-001` |
| Best-Effort Usage Telemetry | `FND-017`, `AUT-013` |
| Repository Conflict Detection | `GHB-009` |
| Portable Planning Workflows | `AUT-012` |

## Orphan-risk ownership

These assignments are mandatory plan scope, not optional cleanup.

| Risk | Explicit owner | Proof requirement |
|---|---|---|
| `ORP-01` Team onboarding and owner promotion absent from Foundation wording | `FND-002` | Two-owner team is created through supported flows. |
| `ORP-02` Shared runners and Team Dispatch Exposures have no later slice | `FND-015` | Cross-owner exact exposure and revocation are dogfooded. |
| `ORP-03` MCP semantic parity has no slice exit | `FND-014` | Web/CLI/MCP contract parity suite passes. |
| `ORP-04` Reference-first Context Recipes have no slice owner | `FND-016`, refined by `GHB-002` and `OUT-003` | Generic recipe plus connector references are proven. |
| `ORP-05` Usage telemetry has no slice owner | `FND-017`, `AUT-013` | Attempt and workflow partial coverage are proven. |
| `ORP-06` Portable Planning Workflows are absent from automation exit | `AUT-012` | Typed Plan Artifact flow is executed. |
| `ORP-07` Advisory dependencies are absent from GitHub slice wording | `GHB-012` | All advisory states are exercised without blocking. |
| `ORP-08` Standalone Team Run Templates could hide inside workflow work | `AUT-001` | Template version/binding behavior is tested independently. |
| `ORP-09` Project discovery/global registry has no slice | `FND-003` | Inside/outside repository discovery passes. |
| `ORP-10` Offline mutation lease behavior is not in the Foundation exit sentence | `FND-009` | Inspect-only versus mutating disconnect drill passes. |
| `ORP-11` Encrypted runner-local diagnostic tail has no phase | `FND-018` | Local-only bounds and expiry drill passes. |
| `ORP-12` MCP thinness and adapter separation lack proof | `FND-005`, `FND-014` | Dependency tests prevent policy/connector code in protocol adapters. |
| `ORP-13` One-week dogfood criterion is not reproducible by itself | `FND-019` | Versioned incident/run log defines direct repair and records none. |
| `ORP-14` GitHub checks and repository gate abstraction are split ambiguously | `GHB-011`, `AUT-009` | GitHub owns exact-SHA observation; automation owns manifests and Gate Sets. |
| `ORP-15` Member offboarding crosses execution and connectors | `FND-002`, `FND-007`, `GHB-013`, `OUT-008` | Identity, permit, runner, GitHub, and Outline revocation drills pass. |

## Cross-phase gates

1. GitHub and Outline cannot begin credential persistence until `FND-002`, `FND-007`, `FND-012`, and `FND-013` pass.
2. Connector mutations cannot ship until exact-revision operation authorization from `FND-007` is available.
3. GitHub delivery depends on `FND-010` and `FND-011`; automation depends on the complete GitHub phase for real-PR dogfood.
4. Outline and GitHub may proceed in parallel only after Foundation exit; neither may create a second identity, audit, credential, or authority implementation.
5. Automation cannot bypass earlier phase adapters: it creates ordinary Agent Runs, connector operations, and Gate Evaluations through the same stable interfaces.

## Four canonical dogfood exits

The following criteria are retained verbatim from the Product Spec and must appear unchanged in the owning phase evidence record.

### Foundation

> Exit when both owners can start headless and interactive Claude or Codex attempts on their own trusted machines from web and CLI; exact permit replay and stale-policy cases fail; a lost runner produces run `WAITING` plus attempt `LOST`; server backup and isolated restore drills pass; and one week of dogfood produces no need for direct database repair.

### GitHub coordination

> Exit when a real connected issue can be triaged, assigned, delegated, implemented, published with a closing reference, reviewed, merged, and observed closing from GitHub without Collab fabricating source state; missed webhook reconciliation, stale replace-style edits, late source linking, and connector scope narrowing are exercised successfully.

### Outline collaboration

> Exit when two members can co-edit an Outline document through Collab with correct native attribution; an agent can iterate only inside an exact grant; concurrent external edits create a conflict proposal; revoked member and bot grants stop new external operations; and no raw document body appears in run logs, backups outside encrypted connector storage, or runner outboxes.

### Bounded automation

> Exit when the team dogfoods **Implementation -> parallel Claude and Codex review -> conditional Fix -> Terminal** on a real pull request with different runtimes or models per step; validation catches missing terminal and fix paths; restart and duplicate events create no duplicate run; pause and waiting do not extend the deadline; and no process remains parked for a human decision.
