> **Authority level:** Derived explanation; does not add or amend product behavior.  
> **Canonical source:** [`PRODUCT-SPEC.md`](../product/PRODUCT-SPEC.md). If this document conflicts with the Product Spec, the Product Spec wins.

# Domain Model

## Purpose and canonical anchors

This document defines implementation-facing aggregates, identifiers, states, transitions, and invariants. It derives from:

- [`System Role and Authority`](../product/PRODUCT-SPEC.md#system-role-and-authority)
- [`GitHub Issues V1 Role`](../product/PRODUCT-SPEC.md#github-issues-v1-role)
- [`Assignment and Delegation V1`](../product/PRODUCT-SPEC.md#assignment-and-delegation-v1)
- [`Agent Run Lifecycle V1`](../product/PRODUCT-SPEC.md#agent-run-lifecycle-v1)
- [`Run Results and Retry Budget V1`](../product/PRODUCT-SPEC.md#run-results-and-retry-budget-v1)
- [`Execution Attempt Lifecycle V1`](../product/PRODUCT-SPEC.md#execution-attempt-lifecycle-v1)
- [`Loop Execution V1`](../product/PRODUCT-SPEC.md#loop-execution-v1)
- [`Agent Run Worktree Ownership V1`](../product/PRODUCT-SPEC.md#agent-run-worktree-ownership-v1)
- [`Work Item Mutation Guard V1`](../product/PRODUCT-SPEC.md#work-item-mutation-guard-v1)
- [`Connector Authority and Revocation V1`](../product/PRODUCT-SPEC.md#connector-authority-and-revocation-v1)
- [`Member Offboarding and Authority Revocation V1`](../product/PRODUCT-SPEC.md#member-offboarding-and-authority-revocation-v1)
- [`Automated Run Workflows V1`](../product/PRODUCT-SPEC.md#automated-run-workflows-v1)
- [`Workflow Execution Lifecycle V1`](../product/PRODUCT-SPEC.md#workflow-execution-lifecycle-v1)
- [`Diff Evidence and Review Policy V1`](../product/PRODUCT-SPEC.md#diff-evidence-and-review-policy-v1)
- [`Repository-Defined Quality Gates V1`](../product/PRODUCT-SPEC.md#repository-defined-quality-gates-v1)
- [`Universal Coordination Record V1`](../product/PRODUCT-SPEC.md#universal-coordination-record-v1)

## Authority ownership

| Authority | Owns | 2Collab representation |
|---|---|---|
| GitHub | Issue, pull-request, Milestone, Project, check, permission, and native lifecycle state | Refreshable projection, reference, confirmed mutation result |
| Outline | Document content, collection placement, source revision, sharing, and native identity attribution | Live search result, reference, proposal, grant, confirmed mutation result |
| 2Collab server | Team membership, Coordination Records, Agent Runs, attempts, workflows, permits, sessions, leases, approvals, evidence, and provenance | Authoritative SQLite aggregates |
| Registered Runner | Worktrees, terminals, processes, local profiles, developer credentials, and local diagnostic data | Opaque identifiers, heartbeats, structured events, bounded evidence |

A projection never becomes another system's authority. Source state, Agent Run state, Workflow Execution state, pull-request state, and process state are separate facts.

## Identifier rules

Identifiers are opaque, immutable, and scoped explicitly. Transport and persistence use branded identifiers rather than unqualified strings.

```ts
type TeamId = Brand<string, "TeamId">;
type MemberId = Brand<string, "MemberId">;
type ProjectId = Brand<string, "ProjectId">;
type ConnectorId = Brand<string, "ConnectorId">;
type CoordinationRecordId = Brand<string, "CoordinationRecordId">;
type AgentRunId = Brand<string, "AgentRunId">;
type ExecutionAttemptId = Brand<string, "ExecutionAttemptId">;
type WorkflowExecutionId = Brand<string, "WorkflowExecutionId">;
type RegisteredRunnerId = Brand<string, "RegisteredRunnerId">;
type DispatchPermitId = Brand<string, "DispatchPermitId">;
type AuthoritySessionId = Brand<string, "AuthoritySessionId">;
type ApprovalSubjectId = Brand<string, "ApprovalSubjectId">;
type GateEvaluationId = Brand<string, "GateEvaluationId">;
```

Every mutable aggregate carries an integer revision. Commands that depend on a prior view include the expected revision and fail visibly when stale.

## Aggregate map

### Team and Member

One deployment contains exactly one Team. A solo developer is a one-member Team; there is no separate personal-account model.

```ts
type TeamRole = "OWNER" | "MEMBER";
```

- A Team has one opaque identifier and any number of Projects.
- Team membership grants visibility and day-to-day collaboration in every Project.
- There is no project membership, project invitation, private project, or project role.
- Multiple `OWNER` members are valid; removing or demoting the final `OWNER` is transactionally rejected.
- Runner ownership is personal and does not follow Team role.
- Member offboarding increments the Member authority epoch and revokes the Member's sessions, devices, permits, capabilities, grants, approvals, and runner identities.

### Project and connector scope

A Project groups repository mappings, source scopes, context scopes, Coordination Records, Runs, and Workflows. It is an organizational and external-scope aggregate, not a human ACL.

Each connector scope and credential carries a versioned connector epoch. Scope reduction increments affected epochs before pending operations are invalidated. External writes always recheck the current epoch and exact source revision immediately before the provider call.

### Coordination Record

A Coordination Record is the durable thread for related runs, sources, artifacts, evidence, and mutation coordination.

- Every Agent Run belongs to exactly one Coordination Record.
- Source-free launch creates the minimal Coordination Record and Agent Run in one transaction.
- A Coordination Record has no writable backlog state, priority, assignee, estimate, sprint, due date, or completion lifecycle.
- Each connector-owned actionable source item maps canonically through:

```text
(project_id, connector_id, source_item_id) -> coordination_record_id
```

- A unique constraint enforces that mapping.
- Concurrent attempts to link two source-free records to the same source item identify the canonical record or require an explicit audited coalescing transaction. Completed provenance is aliased, not rewritten.
- The Work Item Mutation Guard belongs to the Coordination Record.

### Agent Run

An Agent Run is one durable, outcome-oriented activity with one Run Goal and immutable Effective Run Configuration. It may have multiple sequential Execution Attempts only while each pursues the same goal.

```ts
type AgentRunState =
  | "QUEUED"
  | "RUNNING"
  | "WAITING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

type RunResult = "DELIVERED" | "NO_CHANGES" | "BLOCKED" | "ESCALATED";

type ExecutionPolicy = "ONCE" | "MANAGED_LOOP";
```

```text
QUEUED -> RUNNING <-> WAITING
             |           |
             +-----------+-> COMPLETED | FAILED | CANCELLED
```

- `QUEUED`: durable, but no attempt process has started.
- `RUNNING`: actively executing or progressing through automatic durable policy; not waiting for a human.
- `WAITING`: checkpointed with a typed reason and next action; no process remains parked.
- Terminal states are immutable.
- `DELIVERED` and `NO_CHANGES` are claims evaluated against goal, gates, source predicates, review policy, and evidence.
- `BLOCKED` and `ESCALATED` require typed reasons and move the run to `WAITING` when continuation is possible.
- A materially new goal creates a follow-up Agent Run.
- Every run snapshots a positive maximum attempt count and absolute deadline. The default maximum is one.

### Execution Attempt

An Execution Attempt is exactly one runner-supervised operating-system agent process or interactive session invocation.

```ts
type ExecutionAttemptState =
  | "PENDING"
  | "STARTING"
  | "RUNNING"
  | "EXITED"
  | "FAILED_TO_START"
  | "CANCELLED"
  | "TIMED_OUT"
  | "LOST";

type AgentOutcome = "CONTINUE" | "GOAL_ACHIEVED" | "ESCALATE";
```

```text
PENDING -> STARTING -> RUNNING
                        |
                        +-> EXITED | FAILED_TO_START | CANCELLED | TIMED_OUT | LOST
```

- Terminal attempt states are immutable.
- Every created attempt consumes the run's attempt budget, including failed starts and lost processes.
- Exit code and Agent Outcome are evidence; neither completes or fails the Agent Run directly.
- A `LOST` attempt is never resurrected. A later discovered orphan is terminated or quarantined; continuation creates another attempt.
- Attempts within one Agent Run are sequential. At most one is `STARTING` or `RUNNING` against its worktree.
- Reconnecting to the same live process is not a new attempt. Starting a replacement process is.

### Durable Checkpoint and recoverable state

A Durable Checkpoint records bounded progress, reason, requested action, runner/worktree identity, exact revisions, safe evidence, and minimum resume guidance. Human decisions append; they never rewrite the checkpoint.

Runner-local state and portable state remain distinct. The latest verified Published Git Reference or Recoverable Remote Reference is the honest portable continuation point. Process memory, terminal state, uncommitted files, ignored files, and local credentials are never reconstructed from server history.

### Agent Run Worktree

- One Agent Run owns one dedicated worktree and branch and reuses them across sequential attempts.
- Separate Agent Runs always use separate worktrees.
- Worktree creation pins the Agent Run to its Registered Runner.
- Before pinning, a `PENDING` attempt may be retargeted. After pinning, continuation on another runner requires a follow-up Agent Run from a verified remote reference.
- Terminal cleanup requires no active attempt, a clean tracked and untracked tree, and proof that `HEAD` is reachable from the Published Git Reference.
- Dirty, untracked, unpublished, or cleanup-failed state becomes Retained Local Work. Only the runner owner may discard it.

### Repository authority and mutation coordination

```ts
type RepositoryMode = "MUTATING" | "INSPECT_ONLY";
type RepositoryAssurance = "ADVISORY" | "ENFORCED";
```

- `MUTATING` may modify and publish only while live authority exists.
- `INSPECT_ONLY` receives no mutation lease, connector-write authority, or publish operation. A worktree change is a visible policy violation, never implicit promotion.
- `ADVISORY` describes trusted unsandboxed Native or Orca execution. It coordinates and withholds 2Collab capabilities but does not claim to prevent ambient local credential use.
- `ENFORCED` requires an execution adapter that technically prevents prohibited filesystem, git, network, credential, and connector operations. An unsupported binding fails closed.
- One non-terminal `MUTATING` Agent Run reserves the Coordination Record's mutation guard by default. Its active attempt also renews a short live mutation lease.
- Concurrent `INSPECT_ONLY` runs do not reserve the guard.
- Explicit mutation-guard override records actor, reason, time, and colliding runs; workflows cannot encode an automatic override.
- Runs on different Coordination Records may mutate concurrently. Changed-path overlap creates an advisory Repository Collision, not automatic cancellation.

### Registered Runner and execution configuration

```ts
type RunnerDispatchAudience = "OWNER_ONLY" | "TEAM";
type ExecutionHost = "NATIVE" | "ORCA";
type InteractionMode = "HEADLESS" | "INTERACTIVE";
type LocalPresence = "ATTACHED" | "DETACHED";
```

- A Registered Runner has one immutable owner, runner epoch, project mappings, advertised adapters/hosts, heartbeat, policy revision, and audience.
- `TEAM` exposure applies only to exact project-mapping and Custom Launch Profile version pairs after versioned acknowledgement.
- Runtime adapter, host, mode, audience, Repository Mode, and Repository Assurance are independent.
- Local Presence is live status beneath an interactive attempt, not a lifecycle or authorization state.
- Effective Run Configuration snapshots visible template, preset, profile, bounds, grants, gates, and provenance without runner-local command details or secrets.

### Workflow Execution

```ts
type WorkflowExecutionState =
  | "ACTIVE"
  | "WAITING"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

type WorkflowJoin = "ALL" | "ANY";
type AnyRemainderPolicy = "CANCEL_REMAINDER" | "LET_FINISH";
```

- Every step occurrence has one stable idempotency key and binds to at most one distinct Agent Run.
- Workflow transitions consume only an authoritative terminal run plus a validated typed result.
- Prompts, logs, prose, comments, and exit codes never choose a transition.
- Every workflow snapshots maximum total runs, positive cycle traversal bounds, maximum branch count, maximum concurrency, and an absolute deadline.
- The deadline advances in `ACTIVE`, `WAITING`, and `PAUSED`; expiry yields `FAILED` with `WORKFLOW_DEADLINE_EXCEEDED` and invalidates future launches.
- A Parallel Step Group contains only `INSPECT_ONLY` runs. Parallel `MUTATING` steps under one Coordination Record are invalid.
- `ALL` waits for every terminal branch. `ANY` commits at most one accepted result and requires a fallback and remainder policy.
- Cancelling a child run does not implicitly cancel its workflow. Cancelling a workflow invalidates future launches and best-effort cancels active children without rewriting their lifecycles.
- Each workflow step receives fresh execution authorization; authority never carries from an earlier step.

### Stop policy

```ts
type PredicateResult = "TRUE" | "FALSE" | "UNKNOWN";
```

Managed Loop policies are typed `ALL`, `ANY`, `NOT`, source predicates, Agent Outcome predicates, and durable `CONSECUTIVE_MATCHES`. There is no arbitrary code, shell, or interpolated expression.

- A Managed Loop has a semantic stop condition, positive maximum attempts, and absolute deadline.
- A Runtime-Owned Loop is one opaque attempt and still has an absolute deadline.
- `UNKNOWN` fails closed and prevents another attempt. Refresh uses bounded backoff; prolonged uncertainty moves the run to `WAITING` with `SOURCE_UNAVAILABLE`.
- Unknown evaluation neither increments nor resets consecutive-match counters.

### Approval Subject, review, and gates

```ts
type DiffDecision = "APPROVED" | "CHANGES_REQUESTED" | "ESCALATE";
type GateKind = "LOCAL_COMMAND" | "GITHUB_CHECK";
```

- An Approval Subject binds the decision to exact run, base/head SHAs, Published Git Reference when present, evidence revisions and digests, Gate Evaluations, Effective Run Configuration digest, source revisions, and allowed transition.
- Head movement, dirty-state change, gate rerun, evidence replacement, configuration change, or source revision change yields `APPROVAL_STALE`.
- Approval permits only its named transition and never widens runner, connector, repository, grant, bounds, or profile authority.
- Every `MUTATING` run records bounded Diff Evidence before delivery readiness or completion.
- Project Gates come from the pinned trusted base revision and an owner-approved manifest fingerprint.
- Gate Evaluation binds one run, exact repository revision, gate key, fingerprint, and kind. Head movement makes it stale.
- Local gates execute argument arrays without a shell. GitHub checks are observed on the exact Published Git Reference.

## Cross-aggregate invariants

1. Source lifecycle, Agent Run lifecycle, Workflow Execution lifecycle, pull-request lifecycle, and process lifecycle never collapse into one state.
2. Human Assignment and agent Delegation are independent auditable operations.
3. No exit code, runtime event, source event, or pull-request merge directly rewrites another aggregate's lifecycle.
4. Terminal aggregates and historical evidence are immutable.
5. A previous permit, approval, profile, grant, connector epoch, or workflow step never grants authority to a later attempt implicitly.
6. Idempotency keys prevent duplicate run, attempt, step, transition, webhook, outbox, and external-write effects.
7. Exact revisions and digests are required wherever approval, gate, publish, or external mutation semantics depend on content.
8. No aggregate stores raw source bodies, raw diffs, raw terminal transcripts, local absolute paths, environment dumps, or credentials merely for convenience.
