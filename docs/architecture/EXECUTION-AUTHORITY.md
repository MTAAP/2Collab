> **Authority level:** Derived explanation; does not add or amend product behavior.  
> **Canonical source:** [`PRODUCT-SPEC.md`](../product/PRODUCT-SPEC.md). If this document conflicts with the Product Spec, the Product Spec wins.

# Execution Authority

## Purpose and canonical anchors

`ExecutionAuthority` is the deep shared-server module at the intent-to-attempt seam. It concentrates rules that would otherwise be duplicated by web, CLI, MCP, workflows, schedulers, and runner transport. It derives from:

- [`Work Item Mutation Guard V1`](../product/PRODUCT-SPEC.md#work-item-mutation-guard-v1)
- [`Connector Authority and Revocation V1`](../product/PRODUCT-SPEC.md#connector-authority-and-revocation-v1)
- [`Member Offboarding and Authority Revocation V1`](../product/PRODUCT-SPEC.md#member-offboarding-and-authority-revocation-v1)
- [`Diff Evidence and Review Policy V1`](../product/PRODUCT-SPEC.md#diff-evidence-and-review-policy-v1)
- [`Repository-Defined Quality Gates V1`](../product/PRODUCT-SPEC.md#repository-defined-quality-gates-v1)
- [`Execution Host and Interaction Axes V1`](../product/PRODUCT-SPEC.md#execution-host-and-interaction-axes-v1)
- [`Local Interactive Security Boundary V1`](../product/PRODUCT-SPEC.md#local-interactive-security-boundary-v1)
- [`Execution Authority and Runner Exposure V1`](../product/PRODUCT-SPEC.md#execution-authority-and-runner-exposure-v1)
- [`Dispatch Authorization for Retries and Managed Loops V1`](../product/PRODUCT-SPEC.md#dispatch-authorization-for-retries-and-managed-loops-v1)
- [`Prepared Execution Adapter Contract V1`](../product/PRODUCT-SPEC.md#prepared-execution-adapter-contract-v1)
- [`Runtime-Agnostic Dispatch V1`](../product/PRODUCT-SPEC.md#runtime-agnostic-dispatch-v1)
- [`Secure Runner Data Plane`](../product/PRODUCT-SPEC.md#secure-runner-data-plane)
- [`Offline Safety Boundary`](../product/PRODUCT-SPEC.md#offline-safety-boundary)

## Module interface

The interface has one side-effect-free preview method, one closed command method, and one closed query method. Callers learn the command or query they need, not the implementation's lifecycle reducers, policy graph, transaction structure, or adapters. The command method also accepts bounded coordination observations so callers never have to order a separate public Run Coordinator call around an authority decision.

```ts
interface ExecutionAuthority {
  preview(request: AuthorityPreviewRequest): Promise<AuthorityPreview>;
  execute<C extends CollabCommand>(command: C): Promise<Result<CommandResultFor<C>>>;
  query<Q extends CoordinationQuery>(query: Q): Promise<Result<QueryResultFor<Q>>>;
}

type CollabCommand =
  | LaunchRun
  | AuthorizeAttempt
  | AcceptAttemptEvent
  | RecordCheckpoint
  | RecordEvidence
  | RecordRunResult
  | LinkSourceReference
  | AcknowledgeCollision
  | ConsumePermit
  | RenewAuthoritySession
  | AuthorizeOperation
  | ReleaseAuthoritySession
  | ReplaceRunnerPolicy
  | ApplyRevocation;

type CoordinationQuery =
  | InspectCoordinationRecord
  | InspectRun
  | InspectAttempt
  | InspectEvidence
  | InspectProjection;
```

Every command carries a unique idempotency key, authenticated actor, expected aggregate revisions, and requested operation. Reusing a key with identical input returns the original committed result. Reusing it with different input returns `IDEMPOTENCY_CONFLICT`.

Attempt events, checkpoints, evidence, results, links, and acknowledgements are closed bounded schemas. The implementation routes them through private lifecycle and evidence modules. No raw transcript, source body, diff, environment, credential, command, or absolute path is accepted.

### Preview

```ts
type AuthorityPreviewRequest = {
  actor: MemberActor;
  projectId: ProjectId;
  coordinationRecordId?: CoordinationRecordId;
  repository: RepositoryRequest;
  execution: ExecutionSelection;
  workflow?: WorkflowAuthorityRef;
};

type AuthorityPreview = {
  evaluatedAt: Instant;
  eligibleTargets: readonly EligibleTarget[];
  requirements: readonly AuthorityFact[];
  warnings: readonly AuthorityFact[];
};
```

Preview is explanatory and side-effect free. It is never a permit, reservation, approval, or guarantee. `LaunchRun` repeats every check against current state.

### Commands

```ts
type CommandBase = {
  idempotencyKey: IdempotencyKey;
  actor: MemberActor | SchedulerActor | RunnerActor;
};

type LaunchRun = CommandBase & {
  kind: "LAUNCH_RUN";
  projectId: ProjectId;
  coordination:
    | { kind: "NEW"; title: string; sourceRefs: readonly SourceRef[] }
    | {
        kind: "EXISTING";
        coordinationRecordId: CoordinationRecordId;
        expectedRevision: number;
      };
  goal: string;
  repository: RepositoryRequest;
  execution: ExecutionSelection;
  effectiveConfiguration: EffectiveRunConfigurationRef;
  workflow?: WorkflowAuthorityRef;
};

type AuthorizeAttempt = CommandBase & {
  kind: "AUTHORIZE_ATTEMPT";
  runId: AgentRunId;
  expectedRunRevision: number;
  cause:
    | { kind: "RETRY"; previousAttemptId: ExecutionAttemptId }
    | { kind: "RESUME"; checkpointId: DurableCheckpointId }
    | { kind: "MANAGED_LOOP"; iteration: number }
    | { kind: "HUMAN_DECISION"; approvalSubjectId: ApprovalSubjectId };
  execution: ExecutionSelection;
};

type ConsumePermit = CommandBase & {
  kind: "CONSUME_PERMIT";
  permit: SignedDispatchPermit;
  runnerId: RegisteredRunnerId;
  runnerEpoch: number;
  connectionId: RunnerConnectionId;
};

type RenewAuthoritySession = CommandBase & {
  kind: "RENEW_AUTHORITY_SESSION";
  sessionId: AuthoritySessionId;
  sessionFence: number;
  runnerEpoch: number;
};

type AuthorizeOperation = CommandBase & {
  kind: "AUTHORIZE_OPERATION";
  sessionId: AuthoritySessionId;
  sessionFence: number;
  operation: SensitiveOperation;
};

type ReleaseAuthoritySession = CommandBase & {
  kind: "RELEASE_AUTHORITY_SESSION";
  sessionId: AuthoritySessionId;
  sessionFence: number;
  reason: "ATTEMPT_EXITED" | "CHECKPOINTED" | "CANCELLED" | "TIMED_OUT";
};

type ReplaceRunnerPolicy = CommandBase & {
  kind: "REPLACE_RUNNER_POLICY";
  runnerId: RegisteredRunnerId;
  expectedPolicyRevision: number;
  replacement: RunnerPolicyReplacement;
};

type ApplyRevocation = CommandBase & {
  kind: "APPLY_REVOCATION";
  source:
    | { kind: "MEMBER"; memberId: MemberId; authorityEpoch: number }
    | { kind: "CONNECTOR"; connectorId: ConnectorId; connectorEpoch: number }
    | { kind: "RUNNER"; runnerId: RegisteredRunnerId; runnerEpoch: number }
    | { kind: "EXPOSURE"; exposureId: TeamDispatchExposureId; revision: number }
    | { kind: "REPOSITORY"; repositoryId: ConnectedRepositoryId; revision: number }
    | { kind: "RUN"; runId: AgentRunId; revision: number };
};
```

Membership, connector, and cancellation modules commit their own authoritative change first, then submit `APPLY_REVOCATION` in the same transaction or through a durable idempotent intent. Revocation policy is not reconstructed by transport callers.

## Core value types

```ts
type MemberActor = {
  kind: "MEMBER";
  memberId: MemberId;
  sessionId: SessionId;
};

type SchedulerActor = {
  kind: "SCHEDULER";
  originalDispatcherId: MemberId;
  workflowExecutionId?: WorkflowExecutionId;
};

type RunnerActor = {
  kind: "RUNNER";
  runnerId: RegisteredRunnerId;
  runnerEpoch: number;
};

type RepositoryRequest = {
  repositoryId: ConnectedRepositoryId;
  mode: "MUTATING" | "INSPECT_ONLY";
  assurance: "ADVISORY" | "ENFORCED";
  base:
    | { kind: "EXACT"; commitSha: CommitSha }
    | { kind: "RESOLVE_DEFAULT_BASE" };
  intendedBranch?: string;
};

type ExecutionSelection = {
  runnerId: RegisteredRunnerId;
  expectedRunnerEpoch: number;
  projectMappingRevision: number;
  profileVersionId: CustomLaunchProfileVersionId;
  exposureRevision?: number;
  host: "NATIVE" | "ORCA";
  interaction: "HEADLESS" | "INTERACTIVE";
};

type WorkflowAuthorityRef = {
  workflowExecutionId: WorkflowExecutionId;
  stepOccurrenceId: StepOccurrenceId;
  workflowRevision: number;
  effectiveConfigurationDigest: Sha256;
};
```

`SensitiveOperation` is deliberately closed:

```ts
type SensitiveOperation =
  | { kind: "MUTATE_REPOSITORY"; expectedHead: CommitSha }
  | { kind: "PUBLISH_GIT_REFERENCE"; expectedHead: CommitSha; remoteRef: string }
  | {
      kind: "MUTATE_GITHUB";
      connectorId: ConnectorId;
      connectorEpoch: number;
      resource: GitHubResourceRef;
      expectedRevision: string;
      mutation: GitHubMutationKind;
    }
  | {
      kind: "MUTATE_OUTLINE";
      connectorId: ConnectorId;
      connectorEpoch: number;
      documentId: string;
      expectedRevision: string;
      mutation: OutlineMutationKind;
    }
  | {
      kind: "APPLY_APPROVAL_TRANSITION";
      approvalSubjectId: ApprovalSubjectId;
      expectedSubjectDigest: Sha256;
    }
  | {
      kind: "EXECUTE_LOCAL_GATE";
      gateEvaluationId: GateEvaluationId;
      repositoryRevision: CommitSha;
      manifestFingerprint: Sha256;
    }
  | { kind: "DISCARD_RETAINED_WORK"; retainedWorkId: RetainedLocalWorkId };
```

No open string operation, arbitrary provider payload, executable, argument list, path, signal, environment value, or shell fragment is accepted.

## Decisions and explanations

```ts
type AuthorityDecision =
  | {
      decision: "AUTHORIZED";
      artifact:
        | LaunchAuthorization
        | AttemptAuthorization
        | PermitConsumption
        | SessionRenewal
        | OperationAuthorization
        | SessionRelease
        | PolicyReplacement
        | RevocationDisposition;
      explanation: readonly AuthorityFact[];
    }
  | {
      decision: "WAITING";
      code: AuthorityCode;
      retry: "AUTOMATIC" | "EXPLICIT_RESUME" | "SELECT_ANOTHER_TARGET";
      explanation: readonly AuthorityFact[];
    }
  | {
      decision: "DENIED";
      code: AuthorityCode;
      explanation: readonly AuthorityFact[];
    };

type AuthorityFact = {
  subject:
    | "MEMBER"
    | "RUNNER"
    | "EXPOSURE"
    | "PROFILE"
    | "CONNECTOR"
    | "APPROVAL"
    | "REPOSITORY"
    | "MUTATION_LEASE"
    | "WORKFLOW"
    | "DEADLINE";
  outcome: "ALLOWED" | "NOT_REQUIRED" | "WAITING" | "DENIED";
  code: AuthorityCode;
  revision?: string;
  summary: string;
};
```

Safe explanations distinguish dispatcher from runner owner and show Repository Mode, Repository Assurance, exact repository revision, host, interaction mode, profile version, authority source, lease expiry, and denied or waiting reasons. They never expose command arguments, paths, credentials, environment, private profiles, or hidden source content.

Stable expected codes include:

```text
MEMBER_REVOKED
PROJECT_UNAVAILABLE
COORDINATION_REVISION_STALE
RUNNER_OFFLINE
RUNNER_EPOCH_CHANGED
RUNNER_NOT_OWNED_OR_EXPOSED
EXPOSURE_REVOKED
EXPOSURE_REVISION_STALE
PROFILE_UNAVAILABLE
PROFILE_VERSION_MISMATCH
PROJECT_MAPPING_STALE
EXECUTION_HOST_UNAVAILABLE
INTERACTION_MODE_UNSUPPORTED
ASSURANCE_UNAVAILABLE
CONNECTOR_REVOKED
CONNECTOR_UNAVAILABLE
SOURCE_REVISION_STALE
EXACT_REVISION_REQUIRED
APPROVAL_REQUIRED
APPROVAL_STALE
MUTATION_GUARD_HELD
MUTATION_LEASE_LOST
BRANCH_COLLISION
RUNNER_PIN_MISMATCH
ATTEMPT_BUDGET_EXHAUSTED
DEADLINE_EXCEEDED
WORKFLOW_NOT_ACTIVE
WORKFLOW_REVISION_STALE
RUN_TERMINAL
PERMIT_EXPIRED
PERMIT_REPLAYED
PERMIT_REVOKED
SESSION_FENCE_STALE
IDEMPOTENCY_CONFLICT
```

Expected rejection is a decision value. Transport failure, storage corruption, and programmer defects are internal failures with correlation identifiers and never masquerade as policy denial.

## Authority artifacts

### Authority Snapshot

An immutable Authority Snapshot records the exact facts used to authorize one attempt:

- actor and original dispatcher;
- runner and runner owner;
- Team role and Member authority epoch;
- project, Coordination Record, and repository revisions;
- runner epoch and policy revision;
- project mapping, profile, exposure, and acknowledgement revisions;
- runtime, host, interaction mode, Repository Mode, and Repository Assurance;
- connector epochs and requested scopes;
- exact Approval Subjects and Effective Run Configuration digest;
- workflow revision and step occurrence when applicable;
- retry, loop, workflow, concurrency, and deadline bounds;
- mutation-guard reservation and live lease fence when mutating.

### Dispatch Permit

A Dispatch Permit is short-lived, signed, audience-restricted, single-use, and bound to exactly one Execution Attempt and Authority Snapshot. The runner consumes it immediately before process creation. Consumption atomically rejects expiry, replay, revocation, stale epochs or policies, wrong runner connection, and lost mutation authority.

Permit creation does not prove delivery or process start. A committed attempt remains `PENDING` until runner acknowledgement and `STARTING` until the operating-system process is reported started.

### Authority Session

Permit consumption creates a short-lived fenced Authority Session:

```ts
type AuthoritySession = {
  id: AuthoritySessionId;
  attemptId: ExecutionAttemptId;
  fence: number;
  issuedAt: Instant;
  expiresAt: Instant;
  repositoryMode: "MUTATING" | "INSPECT_ONLY";
  assurance: "ADVISORY" | "ENFORCED";
  connectorEpochs: Readonly<Record<ConnectorId, number>>;
  mutationLease?: {
    leaseId: MutationLeaseId;
    fence: number;
    expiresAt: Instant;
  };
};
```

- Every renewal revalidates current epochs, revisions, deadline, cancellation, runner identity, and mutation reservation.
- A stale session fence cannot authorize an operation or overwrite a newer disposition.
- `MUTATING` requires a live mutation lease before local mutation, publish, or external write.
- `INSPECT_ONLY` has no mutation lease, publish, connector-write, or destructive-cleanup capability.
- On `ADVISORY` hosts the session coordinates compliant runner behavior; it does not claim host sandboxing against ambient owner credentials.

## Authorization order

`LAUNCH_RUN` and `AUTHORIZE_ATTEMPT` follow this order:

1. Validate Zod shape, actor credential, command kind, and idempotency key.
2. Refresh only the required GitHub or Outline authority facts outside the SQLite transaction.
3. Begin one SQLite immediate transaction.
4. Validate active Member and original dispatcher epochs.
5. Validate Project and exact Coordination Record revision, creating a source-independent record only for `LAUNCH_RUN` when requested.
6. Validate workflow state, step occurrence, immutable configuration digest, bounds, and deadline.
7. Resolve mutable repository references to an exact commit SHA and validate Repository Assurance.
8. Validate runner heartbeat, epoch, immutable owner, audience, exact Team Dispatch Exposure, acknowledgement, mapping, profile version, host, and interaction compatibility.
9. Recheck connector epochs, scopes, and external revisions against refreshed facts.
10. Validate every Approval Subject by exact identifier, commit SHA, revision, fingerprint, digest, and allowed transition.
11. Validate attempt budget, retry cause, runner pin, predecessor terminal state, and sequential worktree ownership.
12. For `MUTATING`, reserve the Work Item Mutation Guard and issue a fenced live mutation lease; for `INSPECT_ONLY`, issue no write authority.
13. Validate exact intended-branch uniqueness independently from advisory changed-path collisions.
14. Atomically persist run when new, attempt, snapshot, permit record, audit event, and WSS dispatch outbox record.
15. Commit, sign the permit, and schedule WSS delivery.

`CONSUME_PERMIT`, renewal, and operation authorization always recheck authoritative current state. No preview, prior successful attempt, or prior operation removes that requirement.

## Retry and workflow rules

- Every retry, resume, and Managed Loop iteration receives a fresh `AUTHORIZE_ATTEMPT` decision using the original dispatcher as principal. Every workflow step creates its distinct Agent Run through `LAUNCH_RUN` with an exact `WorkflowAuthorityRef`.
- A previous permit, session, approval, exposure, connector grant, or successful process grants no continuing access.
- A failed authorization creates no process and no Execution Attempt and therefore consumes no attempt budget.
- A race rejected after an attempt was committed becomes immutable `FAILED_TO_START` evidence and consumes the normal budget.
- Restoring authority does not silently resume work deliberately stopped by revocation. An authorized Member explicitly resumes it.
- Absolute run and workflow deadlines continue during `WAITING` and `PAUSED` states.
- Each workflow step has its own Agent Run and authority. An earlier step cannot widen a later step.

## Approval and exact-revision rules

Approval Subjects are immutable and operation-specific. A diff approval includes run, base/head SHAs, Published Git Reference when present, Diff Evidence revision/digest, Gate Evaluation identifiers/revisions, Effective Run Configuration digest, source revisions, and decision action.

Any relevant change yields `APPROVAL_STALE`. Approval authorizes only the named transition. It cannot widen runner, connector, Repository Mode, Repository Assurance, Document Write Grant, profile, gate, bounds, or workflow authority.

Every Gate Evaluation binds the exact repository revision and owner-approved manifest fingerprint. Every GitHub or Outline mutation binds the exact source revision and current connector epoch. Provider-side non-atomicity remains visible residual risk and is reconciled after the call.

## Revocation dispositions

```ts
type TerminationDisposition = "REQUESTED" | "CONFIRMED" | "LOST";
```

| Revocation | Immediate effect | Active work |
|---|---|---|
| Member offboarding | Increment Member epoch; end sessions/devices; invalidate permits, capabilities, approvals, grants, runner identities, and future workflow authority | Request checkpoint and termination. Confirmed stop records `CANCELLED`; unreachable work later becomes `LOST`. Meaningful continuation requires another Member's follow-up run from a Recoverable Remote Reference. |
| Cancellation or absolute deadline | Deny future operations and renewals; invalidate unused permits | Request checkpoint and termination; never claim a stopped process without runner evidence. |
| Runner identity or repository authority | Increment relevant epoch and deny permits, sessions, and operations | Request checkpoint and termination; runner-local work remains under machine-owner control. |
| Connector scope or credential | Increment connector epoch; deny affected operations; revoke queued writes and unused permits; stale/redact projections | Continue unrelated local work. Required connector dependency moves run/workflow to `WAITING`; proposals are never auto-applied after reconnect. |
| Team audience or exposure | Invalidate unused permits and block future attempts | Existing valid session continues unless runner owner separately chooses to stop it. |
| Restore | Invalidate server sessions and capabilities; increment connector and runner epochs | No old backup may resurrect a revoked permit, session, token, or queued mutation. |

Dispatcher and runner owner are always recorded as distinct actors. A Team `OWNER` cannot override another person's runner policy merely because of product role.

## Dependency strategy

- Policy evaluation is in-process and private to the implementation.
- SQLite transaction structure is an internal local-substitutable seam exercised with isolated databases; no persistence port appears in the external module interface.
- Outbound WSS runner control is remote-but-owned. Production WSS and in-memory test adapters satisfy a private runner-control port.
- GitHub and Outline are true external ports. Production connector and strict mock adapters satisfy exact-revision authority interfaces.
- Trusted Native, trusted Orca, and future isolated execution are runner-side enforcement adapters behind the same Repository Mode, Repository Assurance, permit, and session vocabulary.

## Required interface tests

1. Identical idempotent launch returns one run/attempt/permit; changed input with the same key returns `IDEMPOTENCY_CONFLICT`.
2. Launch transaction rollback leaves no partial run, lease, permit, audit event, or WSS outbox record.
3. Permit expiry, replay, wrong runner, epoch change, and post-creation revocation are rejected before process creation.
4. Concurrent mutating launches on one Coordination Record yield one reservation unless an explicit override exists.
5. Mutation lease expiry and stale session fence deny mutation, publish, connector write, and renewal.
6. `INSPECT_ONLY` never receives mutation, publish, connector-write, or destructive-cleanup authorization under either assurance.
7. `ENFORCED` launch rejects an advisory-only runner; `ADVISORY` remains visibly advisory.
8. Member offboarding and connector epoch increments invalidate affected permits and sessions with the specified dispositions.
9. Stale diff, gate, source, profile, exposure, workflow, and configuration revisions fail closed with stable codes.
10. Retry and workflow steps reauthorize current state and never inherit earlier authority.
11. WSS reconnect and duplicated frames cannot consume a permit twice or regress a newer session fence.
12. Explanations contain required actor and revision facts but no command, path, environment, credential, or private source content.
