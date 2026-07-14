import { z } from "zod";
import type { AuthenticatedActor, MemberActor } from "./actors.ts";
import { AuthenticatedActorSchema, MemberActorSchema } from "./actors.ts";
import type { CoordinationSelection, SourceRef } from "./context.ts";
import { CoordinationSelectionSchema, SourceRefSchema } from "./context.ts";
import type {
  AgentRunId,
  ApprovalSubjectId,
  AuthoritySessionId,
  CommitSha,
  ConnectorId,
  CoordinationRecordId,
  DurableCheckpointId,
  EvidenceId,
  ExecutionAttemptId,
  GateEvaluationId,
  IdempotencyKey,
  MemberId,
  ProjectId,
  RegisteredRunnerId,
  RunnerConnectionId,
  Sha256,
  TeamDispatchExposureId,
} from "./ids.ts";
import {
  CommitShaSchema,
  IdentifierSchema,
  InstantSchema,
  RevisionSchema,
  Sha256Schema,
} from "./ids.ts";
import type { EffectiveRunConfigurationRef } from "./presets.ts";
import { EffectiveRunConfigurationRefSchema } from "./presets.ts";
import type { ExecutionSelection, RepositoryRequest, RunnerPolicyReplacement } from "./runners.ts";
import {
  EligibleTargetSchema,
  ExecutionSelectionSchema,
  GitRefSchema,
  RepositoryRequestSchema,
} from "./runners.ts";
import type {
  AttemptView,
  AuthoritySessionView,
  CancellationTermination,
  CoordinationRecordView,
  DurableCheckpoint,
  EvidenceInput,
  EvidenceRecord,
  ProjectionView,
  QueuedDispatchMetadata,
  RunView,
} from "./runs.ts";
import {
  AttemptEventSchema,
  AttemptViewSchema,
  AuthoritySessionViewSchema,
  CancellationTerminationSchema,
  CoordinationRecordViewSchema,
  DurableCheckpointSchema,
  EvidenceInputSchema,
  EvidenceRecordSchema,
  ProjectionViewSchema,
  QueuedDispatchMetadataSchema,
  RunViewSchema,
} from "./runs.ts";

export type CommandBase = Readonly<{
  idempotencyKey: IdempotencyKey;
  actor: AuthenticatedActor;
}>;

export type SemanticContinuity = Readonly<{
  localSequence: number;
  predecessorEventId?: string;
}>;

export type WorkflowAuthorityRef = Readonly<{
  workflowExecutionId: string;
  stepOccurrenceId: string;
  workflowRevision: number;
  effectiveConfigurationDigest: Sha256;
}>;

const WorkflowAuthorityRefSchema = z
  .object({
    workflowExecutionId: IdentifierSchema,
    stepOccurrenceId: IdentifierSchema,
    workflowRevision: RevisionSchema,
    effectiveConfigurationDigest: Sha256Schema,
  })
  .strict();

export type LaunchRun = CommandBase &
  Readonly<{
    kind: "LAUNCH_RUN";
    projectId: ProjectId;
    coordination: CoordinationSelection;
    goal: string;
    repository: RepositoryRequest;
    execution: ExecutionSelection;
    effectiveConfiguration: EffectiveRunConfigurationRef;
    workflow?: WorkflowAuthorityRef;
    mutationGuardOverride?: Readonly<{
      guardedRunId: AgentRunId;
      expectedGuardedRunRevision: number;
      expectedGuardFence: number;
      expectedGuardRevision: number;
      reason: string;
    }>;
  }>;

export type AuthorizeAttempt = CommandBase &
  Readonly<{
    kind: "AUTHORIZE_ATTEMPT";
    runId: AgentRunId;
    expectedRunRevision: number;
    cause:
      | Readonly<{ kind: "RETRY"; previousAttemptId: ExecutionAttemptId }>
      | Readonly<{ kind: "RESUME"; checkpointId: DurableCheckpointId }>
      | Readonly<{ kind: "MANAGED_LOOP"; iteration: number }>
      | Readonly<{ kind: "HUMAN_DECISION"; approvalSubjectId: ApprovalSubjectId }>;
    execution: ExecutionSelection;
  }>;

export type CancelRun = CommandBase &
  Readonly<{
    kind: "CANCEL_RUN";
    runId: AgentRunId;
    expectedRunRevision: number;
    reason: "MEMBER_REQUEST" | "DEADLINE" | "WORKFLOW" | "REVOCATION";
  }>;

export type ReconciliationObservation =
  | Readonly<{
      kind: "RUNNER_ATTEMPT";
      attemptId: ExecutionAttemptId;
      observedState: "RUNNING" | "EXITED" | "NOT_FOUND" | "ORPHAN_TERMINATED";
      observedAt: number;
    }>
  | (Readonly<{
      kind: "SOURCE_REVISION";
      connectorId: ConnectorId;
      sourceKind: SourceRef["kind"];
      sourceItemId: string;
      observedAt: number;
    }> &
      (
        | Readonly<{ availability: "AVAILABLE"; observedRevision: string }>
        | Readonly<{
            availability: "MISSING" | "FORBIDDEN" | "UNAVAILABLE";
            observedRevision?: never;
          }>
      ))
  | Readonly<{
      kind: "OUTBOX_DELIVERY";
      deliveryId: string;
      disposition: "DELIVERED" | "RETRYABLE_FAILURE" | "PERMANENT_FAILURE";
      observedAt: number;
    }>;

export type ReconcileObservation = CommandBase &
  Readonly<{
    kind: "RECONCILE_OBSERVATION";
    runId: AgentRunId;
    expectedRunRevision: number;
    observation: ReconciliationObservation;
  }>;

export type AcceptAttemptEvent = CommandBase &
  Readonly<{
    kind: "ACCEPT_ATTEMPT_EVENT";
    runId: AgentRunId;
    expectedRunRevision: number;
    attemptId: ExecutionAttemptId;
    expectedAttemptRevision: number;
    event: z.infer<typeof AttemptEventSchema>;
    semanticContinuity?: SemanticContinuity;
  }>;

export type RecordCheckpoint = CommandBase &
  Readonly<{
    kind: "RECORD_CHECKPOINT";
    runId: AgentRunId;
    expectedRunRevision: number;
    attemptId: ExecutionAttemptId;
    reason: DurableCheckpoint["reason"];
    requestedAction: DurableCheckpoint["requestedAction"];
    summary: string;
    runnerId: RegisteredRunnerId;
    worktreeIdentity: string;
    currentCommit?: CommitSha;
    recoverableRemoteReference?: DurableCheckpoint["recoverableRemoteReference"];
    evidenceIds: readonly EvidenceId[];
    sourceRevisions: Readonly<Record<string, string>>;
    resumeGuidance: string;
    semanticContinuity?: SemanticContinuity;
  }>;

export type RecordEvidence = CommandBase &
  Readonly<{
    kind: "RECORD_EVIDENCE";
    runId: AgentRunId;
    expectedRunRevision: number;
    attemptId?: ExecutionAttemptId;
    evidence: EvidenceInput;
    semanticContinuity?: SemanticContinuity;
  }>;

type RecordRunResultBase = CommandBase &
  Readonly<{
    kind: "RECORD_RUN_RESULT";
    runId: AgentRunId;
    expectedRunRevision: number;
    attemptId: ExecutionAttemptId;
    semanticContinuity?: SemanticContinuity;
  }>;

export type RecordRunResult = RecordRunResultBase &
  (
    | Readonly<{
        result: "DELIVERED" | "NO_CHANGES";
        summary: string;
        evidenceIds: readonly EvidenceId[];
      }>
    | Readonly<{
        result: "BLOCKED" | "ESCALATED";
        summary: string;
        reason: string;
        requestedAction: "RESPOND" | "RESUME" | "SELECT_RUNNER" | "ADOPT_FOLLOW_UP" | "NONE";
        evidenceIds: readonly EvidenceId[];
      }>
  );

export type LinkSourceReference = CommandBase &
  Readonly<{
    kind: "LINK_SOURCE_REFERENCE";
    coordinationRecordId: CoordinationRecordId;
    expectedRevision: number;
    sourceRef: SourceRef;
  }>;

export type AcknowledgeCollision = CommandBase &
  Readonly<{
    kind: "ACKNOWLEDGE_COLLISION";
    coordinationRecordId: CoordinationRecordId;
    expectedRevision: number;
    guardedRunId: AgentRunId;
    expectedGuardedRunRevision: number;
    collidingRunId: AgentRunId;
    expectedCollidingRunRevision: number;
    expectedGuardFence: number;
    expectedGuardRevision: number;
    reason: string;
  }>;

export type ConsumePermit = CommandBase &
  Readonly<{
    kind: "CONSUME_PERMIT";
    permit: string;
    runnerId: RegisteredRunnerId;
    runnerEpoch: number;
    connectionId: RunnerConnectionId;
  }>;

export type RenewAuthoritySession = CommandBase &
  Readonly<{
    kind: "RENEW_AUTHORITY_SESSION";
    sessionId: AuthoritySessionId;
    sessionFence: number;
    runnerEpoch: number;
  }>;

export type GitHubMutationKind =
  | "CREATE_ISSUE"
  | "EDIT_ISSUE"
  | "ADD_COMMENT"
  | "SET_LABELS"
  | "SET_ASSIGNEES"
  | "SET_MILESTONE"
  | "SET_ISSUE_STATE"
  | "CREATE_MILESTONE"
  | "EDIT_MILESTONE"
  | "ADD_PROJECT_ITEM"
  | "REMOVE_PROJECT_ITEM"
  | "SET_PROJECT_FIELD"
  | "MOVE_PROJECT_ITEM";
export type OutlineMutationKind =
  | "CREATE_DOCUMENT_AS_MEMBER"
  | "EDIT_DOCUMENT_AS_MEMBER"
  | "EDIT_DOCUMENT_AS_BOT"
  | "APPLY_PROPOSAL_AS_MEMBER"
  | "PROMOTE_WORKING_DOCUMENT"
  | "ARCHIVE_WORKING_DOCUMENT";

export const GitHubMutationKindSchema = z.enum([
  "CREATE_ISSUE",
  "EDIT_ISSUE",
  "ADD_COMMENT",
  "SET_LABELS",
  "SET_ASSIGNEES",
  "SET_MILESTONE",
  "SET_ISSUE_STATE",
  "CREATE_MILESTONE",
  "EDIT_MILESTONE",
  "ADD_PROJECT_ITEM",
  "REMOVE_PROJECT_ITEM",
  "SET_PROJECT_FIELD",
  "MOVE_PROJECT_ITEM",
]);
export const OutlineMutationKindSchema = z.enum([
  "CREATE_DOCUMENT_AS_MEMBER",
  "EDIT_DOCUMENT_AS_MEMBER",
  "EDIT_DOCUMENT_AS_BOT",
  "APPLY_PROPOSAL_AS_MEMBER",
  "PROMOTE_WORKING_DOCUMENT",
  "ARCHIVE_WORKING_DOCUMENT",
]);

export type SourceMutationPrecondition =
  | Readonly<{ kind: "ABSENT" }>
  | Readonly<{ kind: "EXACT_REVISION"; sourceRevision: string; comparableDigest: Sha256 }>
  | Readonly<{
      kind: "EXPECTED_MEMBERSHIP";
      sourceRevision: string;
      comparableDigest: Sha256;
      memberKey: string;
      present: boolean;
    }>;

export const SourceMutationPreconditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ABSENT") }).strict(),
  z
    .object({
      kind: z.literal("EXACT_REVISION"),
      sourceRevision: z.string().min(1).max(128),
      comparableDigest: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("EXPECTED_MEMBERSHIP"),
      sourceRevision: z.string().min(1).max(128),
      comparableDigest: Sha256Schema,
      memberKey: z.string().min(1).max(256),
      present: z.boolean(),
    })
    .strict(),
]);

export type SensitiveOperation =
  | Readonly<{ kind: "MUTATE_REPOSITORY"; expectedHead: CommitSha }>
  | Readonly<{ kind: "PUBLISH_GIT_REFERENCE"; expectedHead: CommitSha; remoteRef: string }>
  | Readonly<{
      kind: "MUTATE_GITHUB";
      projectId: ProjectId;
      connectorId: ConnectorId;
      connectorEpoch: number;
      resourceId: string;
      precondition: SourceMutationPrecondition;
      actionDigest: Sha256;
      mutation: GitHubMutationKind;
    }>
  | Readonly<{
      kind: "MUTATE_OUTLINE";
      projectId: ProjectId;
      connectorId: ConnectorId;
      connectorEpoch: number;
      documentId: string;
      precondition: SourceMutationPrecondition;
      actionDigest: Sha256;
      mutation: OutlineMutationKind;
    }>
  | Readonly<{
      kind: "APPLY_APPROVAL_TRANSITION";
      approvalSubjectId: ApprovalSubjectId;
      expectedSubjectDigest: Sha256;
    }>
  | Readonly<{
      kind: "EXECUTE_LOCAL_GATE";
      gateEvaluationId: GateEvaluationId;
      repositoryRevision: CommitSha;
      manifestFingerprint: Sha256;
    }>;

const WorktreeAuthorizationBaseSchema = z.object({
  authorizationId: IdentifierSchema,
  runnerId: IdentifierSchema,
  runId: IdentifierSchema,
  worktreeKey: IdentifierSchema,
  expectedHead: CommitShaSchema,
  expiresAt: InstantSchema,
});

export const WorktreeAuthorizationClaimsSchema = z.discriminatedUnion("kind", [
  WorktreeAuthorizationBaseSchema.extend({
    kind: z.literal("ATTEMPT_PUBLISH"),
    attemptId: IdentifierSchema,
    sessionId: IdentifierSchema,
    sessionFence: RevisionSchema,
    remoteIdentity: z.string().min(1).max(128),
    remoteRef: GitRefSchema,
  }).strict(),
  WorktreeAuthorizationBaseSchema.extend({
    kind: z.literal("RETAINED_WORK_PUBLISH"),
    ownerMemberId: IdentifierSchema,
    retainedWorkId: IdentifierSchema,
    observationRevision: RevisionSchema,
    observationDigest: Sha256Schema,
    remoteIdentity: z.string().min(1).max(128),
    remoteRef: GitRefSchema,
  }).strict(),
  WorktreeAuthorizationBaseSchema.extend({
    kind: z.literal("RETAINED_WORK_DISCARD"),
    ownerMemberId: IdentifierSchema,
    retainedWorkId: IdentifierSchema,
    observationRevision: RevisionSchema,
    observationDigest: Sha256Schema,
    remoteIdentity: z.string().min(1).max(128),
    remoteRef: GitRefSchema,
  }).strict(),
  WorktreeAuthorizationBaseSchema.extend({
    kind: z.literal("COMMITTED_CLEANUP"),
    runState: z.enum(["QUEUED", "RUNNING", "WAITING", "COMPLETED", "FAILED", "CANCELLED"]),
    noActiveAttempt: z.boolean(),
  }).strict(),
]);
export type WorktreeAuthorizationClaims = Readonly<
  z.infer<typeof WorktreeAuthorizationClaimsSchema>
>;

export const WorktreeAuthorizationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ATTEMPT_PUBLISH"), token: z.string().min(1).max(8_192) }).strict(),
  z
    .object({ kind: z.literal("RETAINED_WORK_PUBLISH"), token: z.string().min(1).max(8_192) })
    .strict(),
  z
    .object({ kind: z.literal("RETAINED_WORK_DISCARD"), token: z.string().min(1).max(8_192) })
    .strict(),
  z.object({ kind: z.literal("COMMITTED_CLEANUP"), token: z.string().min(1).max(8_192) }).strict(),
]);
export type WorktreeAuthorization = Readonly<z.infer<typeof WorktreeAuthorizationSchema>>;
export type AttemptPublishAuthorization = Extract<
  WorktreeAuthorization,
  { kind: "ATTEMPT_PUBLISH" }
>;
export type RetainedWorkPublishAuthorization = Extract<
  WorktreeAuthorization,
  { kind: "RETAINED_WORK_PUBLISH" }
>;
export type RetainedWorkDiscardAuthorization = Extract<
  WorktreeAuthorization,
  { kind: "RETAINED_WORK_DISCARD" }
>;
export type CommittedCleanupAuthorization = Extract<
  WorktreeAuthorization,
  { kind: "COMMITTED_CLEANUP" }
>;

export type AuthorizeOperation = CommandBase &
  Readonly<{
    kind: "AUTHORIZE_OPERATION";
    sessionId: AuthoritySessionId;
    sessionFence: number;
    operation: SensitiveOperation;
  }>;

export type ReleaseAuthoritySession = CommandBase &
  Readonly<{
    kind: "RELEASE_AUTHORITY_SESSION";
    sessionId: AuthoritySessionId;
    sessionFence: number;
    reason: "ATTEMPT_EXITED" | "CHECKPOINTED" | "CANCELLED" | "TIMED_OUT";
  }>;

export type ReplaceRunnerPolicy = CommandBase &
  Readonly<{
    kind: "REPLACE_RUNNER_POLICY";
    runnerId: RegisteredRunnerId;
    expectedPolicyRevision: number;
    replacement: RunnerPolicyReplacement;
  }>;

export type RevocationSource =
  | Readonly<{ kind: "MEMBER"; memberId: MemberId; authorityEpoch: number }>
  | Readonly<{ kind: "CONNECTOR"; connectorId: ConnectorId; connectorEpoch: number }>
  | Readonly<{ kind: "RUNNER"; runnerId: RegisteredRunnerId; runnerEpoch: number }>
  | Readonly<{ kind: "EXPOSURE"; exposureId: TeamDispatchExposureId; revision: number }>
  | Readonly<{ kind: "REPOSITORY"; repositoryId: string; revision: number }>
  | Readonly<{ kind: "RUN"; runId: AgentRunId; revision: number }>;

export type ApplyRevocation = CommandBase &
  Readonly<{ kind: "APPLY_REVOCATION"; source: RevocationSource }>;

export type CollabCommand =
  | LaunchRun
  | AuthorizeAttempt
  | CancelRun
  | ReconcileObservation
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

export type InspectCoordinationRecord = Readonly<{
  kind: "INSPECT_COORDINATION_RECORD";
  actor: AuthenticatedActor;
  coordinationRecordId: CoordinationRecordId;
}>;
export type InspectRun = Readonly<{
  kind: "INSPECT_RUN";
  actor: AuthenticatedActor;
  runId: AgentRunId;
}>;
export type InspectAttempt = Readonly<{
  kind: "INSPECT_ATTEMPT";
  actor: AuthenticatedActor;
  attemptId: ExecutionAttemptId;
}>;
export type InspectEvidence = Readonly<{
  kind: "INSPECT_EVIDENCE";
  actor: AuthenticatedActor;
  runId: AgentRunId;
  after?: EvidenceId;
  limit: number;
}>;
export type InspectProjection = Readonly<{
  kind: "INSPECT_PROJECTION";
  actor: AuthenticatedActor;
  coordinationRecordId: CoordinationRecordId;
}>;
export type ResolvePersonalRunPresetBindings = Readonly<{
  kind: "RESOLVE_PERSONAL_RUN_PRESET_BINDINGS";
  actor: MemberActor;
  bindings: Readonly<
    Record<
      string,
      Readonly<{
        personalRunPresetId: string;
        expectedVersion: number;
        repository: Readonly<{ repositoryId: string; intendedBranch?: string }>;
      }>
    >
  >;
}>;

export type CoordinationQuery =
  | InspectCoordinationRecord
  | InspectRun
  | InspectAttempt
  | InspectEvidence
  | InspectProjection
  | ResolvePersonalRunPresetBindings;

export type CommandResult =
  | Readonly<{
      kind: "LAUNCH_RUN";
      record: CoordinationRecordView;
      run: RunView;
      attempt: AttemptView;
      dispatch: QueuedDispatchMetadata;
    }>
  | Readonly<{
      kind: "AUTHORIZE_ATTEMPT";
      decision:
        | Readonly<{
            outcome: "AUTHORIZED";
            run: RunView;
            attempt: AttemptView;
            dispatch: QueuedDispatchMetadata;
          }>
        | Readonly<{
            outcome: "WAITING";
            run: RunView;
            code: string;
            retry: "EXPLICIT_RESUME" | "SELECT_ANOTHER_TARGET";
          }>
        | Readonly<{ outcome: "DENIED"; code: string }>;
    }>
  | Readonly<{
      kind: "CANCEL_RUN";
      run: RunView;
      termination: CancellationTermination;
    }>
  | Readonly<{ kind: "RECONCILE_OBSERVATION"; reconciled: true }>
  | Readonly<{ kind: "ACCEPT_ATTEMPT_EVENT"; run: RunView; attempt: AttemptView }>
  | Readonly<{ kind: "RECORD_CHECKPOINT"; checkpoint: DurableCheckpoint; run: RunView }>
  | Readonly<{ kind: "RECORD_EVIDENCE"; evidence: EvidenceRecord }>
  | Readonly<{ kind: "RECORD_RUN_RESULT"; run: RunView }>
  | Readonly<{ kind: "LINK_SOURCE_REFERENCE"; record: CoordinationRecordView }>
  | Readonly<{ kind: "ACKNOWLEDGE_COLLISION"; record: CoordinationRecordView }>
  | Readonly<{ kind: "CONSUME_PERMIT"; session: AuthoritySessionView }>
  | Readonly<{ kind: "RENEW_AUTHORITY_SESSION"; session: AuthoritySessionView }>
  | Readonly<{
      kind: "AUTHORIZE_OPERATION";
      authorizationId: string;
      operationDigest: string;
      expiresAt: number;
    }>
  | Readonly<{ kind: "RELEASE_AUTHORITY_SESSION"; released: true }>
  | Readonly<{
      kind: "REPLACE_RUNNER_POLICY";
      runnerId: RegisteredRunnerId;
      policyRevision: number;
    }>
  | Readonly<{ kind: "APPLY_REVOCATION"; applied: true }>;

export type QueryResult =
  | Readonly<{ kind: "INSPECT_COORDINATION_RECORD"; record: CoordinationRecordView }>
  | Readonly<{ kind: "INSPECT_RUN"; run: RunView }>
  | Readonly<{ kind: "INSPECT_ATTEMPT"; attempt: AttemptView }>
  | Readonly<{ kind: "INSPECT_EVIDENCE"; evidence: readonly EvidenceRecord[]; next?: EvidenceId }>
  | Readonly<{ kind: "INSPECT_PROJECTION"; projection: ProjectionView }>
  | Readonly<{
      kind: "RESOLVE_PERSONAL_RUN_PRESET_BINDINGS";
      bindings: Readonly<
        Record<
          string,
          Readonly<{
            personalRunPresetId: string;
            presetVersion: number;
            runtime: "CLAUDE" | "CODEX" | "PI" | "OPENCODE";
            runnerId: string;
            profileVersion: number;
            host: "NATIVE" | "ORCA";
            interaction: "HEADLESS" | "INTERACTIVE";
            repositoryMode: "INSPECT_ONLY" | "MUTATING";
            repositoryAssurance: "ADVISORY" | "ENFORCED";
            repository: Readonly<{ repositoryId: string; intendedBranch?: string }>;
          }>
        >
      >;
      staleKeys: readonly string[];
    }>;

export type CommandResultFor<C extends CollabCommand> = Extract<CommandResult, { kind: C["kind"] }>;
export type QueryResultFor<Q extends CoordinationQuery> = Extract<QueryResult, { kind: Q["kind"] }>;

const CommandBaseSchema = z.object({
  idempotencyKey: IdentifierSchema,
  actor: AuthenticatedActorSchema,
});
const RevisionedRunSchema = {
  runId: IdentifierSchema,
  expectedRunRevision: RevisionSchema,
};

export const SemanticContinuitySchema = z
  .object({
    localSequence: z.number().int().positive(),
    predecessorEventId: IdentifierSchema.optional(),
  })
  .strict();

export const AcceptAttemptEventPayloadSchema = z
  .object({
    ...RevisionedRunSchema,
    attemptId: IdentifierSchema,
    expectedAttemptRevision: RevisionSchema,
    event: AttemptEventSchema,
    semanticContinuity: SemanticContinuitySchema.optional(),
  })
  .strict();

const CheckpointReasonSchema = z.enum([
  "HUMAN_INPUT",
  "RECOVERY",
  "MUTATION_LEASE_EXPIRED",
  "CANCELLATION",
]);
const CheckpointRequestedActionSchema = z.enum(["RESPOND", "RESUME", "ADOPT_FOLLOW_UP", "NONE"]);
const EvidenceIdsSchema = z.array(IdentifierSchema).max(128);

export const RecordCheckpointPayloadSchema = z
  .object({
    ...RevisionedRunSchema,
    attemptId: IdentifierSchema,
    reason: CheckpointReasonSchema,
    requestedAction: CheckpointRequestedActionSchema,
    summary: z.string().min(1).max(2_048),
    runnerId: IdentifierSchema,
    worktreeIdentity: IdentifierSchema,
    currentCommit: CommitShaSchema.optional(),
    recoverableRemoteReference: z
      .object({
        remoteIdentity: z.string().min(1).max(128),
        remoteRef: GitRefSchema,
        commitSha: CommitShaSchema,
        verifiedAt: InstantSchema,
      })
      .strict()
      .optional(),
    evidenceIds: EvidenceIdsSchema,
    sourceRevisions: z
      .record(z.string().min(1).max(256), z.string().min(1).max(128))
      .refine((revisions) => Object.keys(revisions).length <= 128),
    resumeGuidance: z.string().min(1).max(2_048),
    semanticContinuity: SemanticContinuitySchema.optional(),
  })
  .strict();

export const RecordEvidencePayloadSchema = z
  .object({
    ...RevisionedRunSchema,
    attemptId: IdentifierSchema.optional(),
    evidence: EvidenceInputSchema,
    semanticContinuity: SemanticContinuitySchema.optional(),
  })
  .strict();

const RunResultPayloadBase = {
  ...RevisionedRunSchema,
  attemptId: IdentifierSchema,
  summary: z.string().min(1).max(2_048),
  evidenceIds: EvidenceIdsSchema,
  semanticContinuity: SemanticContinuitySchema.optional(),
};
export const RunResultReasonSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const RunResultRequestedActionSchema = z.enum([
  "RESPOND",
  "RESUME",
  "SELECT_RUNNER",
  "ADOPT_FOLLOW_UP",
  "NONE",
]);
export const RecordRunResultPayloadSchema = z.discriminatedUnion("result", [
  z.object({ ...RunResultPayloadBase, result: z.literal("DELIVERED") }).strict(),
  z.object({ ...RunResultPayloadBase, result: z.literal("NO_CHANGES") }).strict(),
  z
    .object({
      ...RunResultPayloadBase,
      result: z.literal("BLOCKED"),
      reason: RunResultReasonSchema,
      requestedAction: RunResultRequestedActionSchema,
    })
    .strict(),
  z
    .object({
      ...RunResultPayloadBase,
      result: z.literal("ESCALATED"),
      reason: RunResultReasonSchema,
      requestedAction: RunResultRequestedActionSchema,
    })
    .strict(),
]);

export type AcceptAttemptEventPayload = Readonly<z.infer<typeof AcceptAttemptEventPayloadSchema>>;
export type RecordCheckpointPayload = Readonly<z.infer<typeof RecordCheckpointPayloadSchema>>;
export type RecordEvidencePayload = Readonly<z.infer<typeof RecordEvidencePayloadSchema>>;
export type RecordRunResultPayload = Readonly<z.infer<typeof RecordRunResultPayloadSchema>>;

export const SensitiveOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("MUTATE_REPOSITORY"), expectedHead: CommitShaSchema }).strict(),
  z
    .object({
      kind: z.literal("PUBLISH_GIT_REFERENCE"),
      expectedHead: CommitShaSchema,
      remoteRef: GitRefSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("MUTATE_GITHUB"),
      projectId: IdentifierSchema,
      connectorId: IdentifierSchema,
      connectorEpoch: RevisionSchema,
      resourceId: z.string().min(1).max(256),
      precondition: SourceMutationPreconditionSchema,
      actionDigest: Sha256Schema,
      mutation: GitHubMutationKindSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("MUTATE_OUTLINE"),
      projectId: IdentifierSchema,
      connectorId: IdentifierSchema,
      connectorEpoch: RevisionSchema,
      documentId: z.string().min(1).max(256),
      precondition: SourceMutationPreconditionSchema,
      actionDigest: Sha256Schema,
      mutation: OutlineMutationKindSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("APPLY_APPROVAL_TRANSITION"),
      approvalSubjectId: IdentifierSchema,
      expectedSubjectDigest: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("EXECUTE_LOCAL_GATE"),
      gateEvaluationId: IdentifierSchema,
      repositoryRevision: CommitShaSchema,
      manifestFingerprint: Sha256Schema,
    })
    .strict(),
]);

export const AuthorizeOperationPayloadSchema = z
  .object({
    sessionId: IdentifierSchema,
    sessionFence: RevisionSchema,
    operation: SensitiveOperationSchema,
  })
  .strict();
export type AuthorizeOperationPayload = Readonly<z.infer<typeof AuthorizeOperationPayloadSchema>>;

export const ConsumePermitPayloadSchema = z
  .object({
    permit: z.string().min(1).max(8_192),
    runnerId: IdentifierSchema,
    runnerEpoch: RevisionSchema,
    connectionId: IdentifierSchema,
  })
  .strict();
export const RenewAuthoritySessionPayloadSchema = z
  .object({
    sessionId: IdentifierSchema,
    sessionFence: RevisionSchema,
    runnerEpoch: RevisionSchema,
  })
  .strict();
export const ReleaseAuthoritySessionPayloadSchema = z
  .object({
    sessionId: IdentifierSchema,
    sessionFence: RevisionSchema,
    reason: z.enum(["ATTEMPT_EXITED", "CHECKPOINTED", "CANCELLED", "TIMED_OUT"]),
  })
  .strict();
export type ConsumePermitPayload = Readonly<z.infer<typeof ConsumePermitPayloadSchema>>;
export type RenewAuthoritySessionPayload = Readonly<
  z.infer<typeof RenewAuthoritySessionPayloadSchema>
>;
export type ReleaseAuthoritySessionPayload = Readonly<
  z.infer<typeof ReleaseAuthoritySessionPayloadSchema>
>;

export const CollabCommandSchema = z.discriminatedUnion("kind", [
  CommandBaseSchema.extend({
    kind: z.literal("LAUNCH_RUN"),
    projectId: IdentifierSchema,
    coordination: CoordinationSelectionSchema,
    goal: z.string().min(1).max(16_384),
    repository: RepositoryRequestSchema,
    execution: ExecutionSelectionSchema,
    effectiveConfiguration: EffectiveRunConfigurationRefSchema,
    workflow: WorkflowAuthorityRefSchema.optional(),
    mutationGuardOverride: z
      .object({
        guardedRunId: IdentifierSchema,
        expectedGuardedRunRevision: RevisionSchema,
        expectedGuardFence: RevisionSchema,
        expectedGuardRevision: RevisionSchema,
        reason: z.string().min(1).max(240),
      })
      .strict()
      .optional(),
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("AUTHORIZE_ATTEMPT"),
    ...RevisionedRunSchema,
    cause: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("RETRY"), previousAttemptId: IdentifierSchema }).strict(),
      z.object({ kind: z.literal("RESUME"), checkpointId: IdentifierSchema }).strict(),
      z
        .object({ kind: z.literal("MANAGED_LOOP"), iteration: z.number().int().positive() })
        .strict(),
      z.object({ kind: z.literal("HUMAN_DECISION"), approvalSubjectId: IdentifierSchema }).strict(),
    ]),
    execution: ExecutionSelectionSchema,
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("CANCEL_RUN"),
    ...RevisionedRunSchema,
    reason: z.enum(["MEMBER_REQUEST", "DEADLINE", "WORKFLOW", "REVOCATION"]),
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("RECONCILE_OBSERVATION"),
    ...RevisionedRunSchema,
    observation: z.union([
      z
        .object({
          kind: z.literal("RUNNER_ATTEMPT"),
          attemptId: IdentifierSchema,
          observedState: z.enum(["RUNNING", "EXITED", "NOT_FOUND", "ORPHAN_TERMINATED"]),
          observedAt: z.number().int().nonnegative(),
        })
        .strict(),
      z.discriminatedUnion("availability", [
        z
          .object({
            kind: z.literal("SOURCE_REVISION"),
            connectorId: IdentifierSchema,
            sourceKind: z.enum(["GITHUB_ISSUE", "GITHUB_PULL_REQUEST", "OUTLINE_DOCUMENT"]),
            sourceItemId: z.string().min(1).max(256),
            availability: z.literal("AVAILABLE"),
            observedRevision: z.string().min(1).max(128),
            observedAt: InstantSchema,
          })
          .strict(),
        ...(["MISSING", "FORBIDDEN", "UNAVAILABLE"] as const).map((availability) =>
          z
            .object({
              kind: z.literal("SOURCE_REVISION"),
              connectorId: IdentifierSchema,
              sourceKind: z.enum(["GITHUB_ISSUE", "GITHUB_PULL_REQUEST", "OUTLINE_DOCUMENT"]),
              sourceItemId: z.string().min(1).max(256),
              availability: z.literal(availability),
              observedAt: InstantSchema,
            })
            .strict(),
        ),
      ]),
      z
        .object({
          kind: z.literal("OUTBOX_DELIVERY"),
          deliveryId: IdentifierSchema,
          disposition: z.enum(["DELIVERED", "RETRYABLE_FAILURE", "PERMANENT_FAILURE"]),
          observedAt: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("ACCEPT_ATTEMPT_EVENT"),
    ...AcceptAttemptEventPayloadSchema.shape,
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("RECORD_CHECKPOINT"),
    ...RecordCheckpointPayloadSchema.shape,
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("RECORD_EVIDENCE"),
    ...RecordEvidencePayloadSchema.shape,
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("RECORD_RUN_RESULT"),
    ...RevisionedRunSchema,
    attemptId: IdentifierSchema,
    result: z.enum(["DELIVERED", "NO_CHANGES", "BLOCKED", "ESCALATED"]),
    summary: z.string().min(1).max(2_048),
    reason: RunResultReasonSchema.optional(),
    requestedAction: RunResultRequestedActionSchema.optional(),
    evidenceIds: EvidenceIdsSchema,
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("LINK_SOURCE_REFERENCE"),
    coordinationRecordId: IdentifierSchema,
    expectedRevision: RevisionSchema,
    sourceRef: SourceRefSchema,
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("ACKNOWLEDGE_COLLISION"),
    coordinationRecordId: IdentifierSchema,
    expectedRevision: RevisionSchema,
    guardedRunId: IdentifierSchema,
    expectedGuardedRunRevision: RevisionSchema,
    collidingRunId: IdentifierSchema,
    expectedCollidingRunRevision: RevisionSchema,
    expectedGuardFence: RevisionSchema,
    expectedGuardRevision: RevisionSchema,
    reason: z.string().min(1).max(240),
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("CONSUME_PERMIT"),
    ...ConsumePermitPayloadSchema.shape,
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("RENEW_AUTHORITY_SESSION"),
    ...RenewAuthoritySessionPayloadSchema.shape,
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("AUTHORIZE_OPERATION"),
    ...AuthorizeOperationPayloadSchema.shape,
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("RELEASE_AUTHORITY_SESSION"),
    ...ReleaseAuthoritySessionPayloadSchema.shape,
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("REPLACE_RUNNER_POLICY"),
    runnerId: IdentifierSchema,
    expectedPolicyRevision: RevisionSchema,
    replacement: z
      .object({
        audience: z.enum(["OWNER_ONLY", "TEAM"]),
        maximumConcurrentAttempts: z.number().int().positive().max(64),
      })
      .strict(),
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("APPLY_REVOCATION"),
    source: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("MEMBER"),
          memberId: IdentifierSchema,
          authorityEpoch: RevisionSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("CONNECTOR"),
          connectorId: IdentifierSchema,
          connectorEpoch: RevisionSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("RUNNER"),
          runnerId: IdentifierSchema,
          runnerEpoch: RevisionSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("EXPOSURE"),
          exposureId: IdentifierSchema,
          revision: RevisionSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("REPOSITORY"),
          repositoryId: IdentifierSchema,
          revision: RevisionSchema,
        })
        .strict(),
      z
        .object({ kind: z.literal("RUN"), runId: IdentifierSchema, revision: RevisionSchema })
        .strict(),
    ]),
  }).strict(),
]);

export const CommandResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("LAUNCH_RUN"),
      record: CoordinationRecordViewSchema,
      run: RunViewSchema,
      attempt: AttemptViewSchema,
      dispatch: QueuedDispatchMetadataSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("AUTHORIZE_ATTEMPT"),
      decision: z.discriminatedUnion("outcome", [
        z
          .object({
            outcome: z.literal("AUTHORIZED"),
            run: RunViewSchema,
            attempt: AttemptViewSchema,
            dispatch: QueuedDispatchMetadataSchema,
          })
          .strict(),
        z
          .object({
            outcome: z.literal("WAITING"),
            run: RunViewSchema,
            code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
            retry: z.enum(["EXPLICIT_RESUME", "SELECT_ANOTHER_TARGET"]),
          })
          .strict(),
        z
          .object({
            outcome: z.literal("DENIED"),
            code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("CANCEL_RUN"),
      run: RunViewSchema,
      termination: CancellationTerminationSchema,
    })
    .strict(),
  z.object({ kind: z.literal("RECONCILE_OBSERVATION"), reconciled: z.literal(true) }).strict(),
  z
    .object({
      kind: z.literal("ACCEPT_ATTEMPT_EVENT"),
      run: RunViewSchema,
      attempt: AttemptViewSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("RECORD_CHECKPOINT"),
      checkpoint: DurableCheckpointSchema,
      run: RunViewSchema,
    })
    .strict(),
  z.object({ kind: z.literal("RECORD_EVIDENCE"), evidence: EvidenceRecordSchema }).strict(),
  z.object({ kind: z.literal("RECORD_RUN_RESULT"), run: RunViewSchema }).strict(),
  z
    .object({ kind: z.literal("LINK_SOURCE_REFERENCE"), record: CoordinationRecordViewSchema })
    .strict(),
  z
    .object({ kind: z.literal("ACKNOWLEDGE_COLLISION"), record: CoordinationRecordViewSchema })
    .strict(),
  z.object({ kind: z.literal("CONSUME_PERMIT"), session: AuthoritySessionViewSchema }).strict(),
  z
    .object({ kind: z.literal("RENEW_AUTHORITY_SESSION"), session: AuthoritySessionViewSchema })
    .strict(),
  z
    .object({
      kind: z.literal("AUTHORIZE_OPERATION"),
      authorizationId: IdentifierSchema,
      operationDigest: Sha256Schema,
      expiresAt: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal("RELEASE_AUTHORITY_SESSION"), released: z.literal(true) }).strict(),
  z
    .object({
      kind: z.literal("REPLACE_RUNNER_POLICY"),
      runnerId: IdentifierSchema,
      policyRevision: RevisionSchema,
    })
    .strict(),
  z.object({ kind: z.literal("APPLY_REVOCATION"), applied: z.literal(true) }).strict(),
]);

export const CoordinationQuerySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("INSPECT_COORDINATION_RECORD"),
      actor: AuthenticatedActorSchema,
      coordinationRecordId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("INSPECT_RUN"),
      actor: AuthenticatedActorSchema,
      runId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("INSPECT_ATTEMPT"),
      actor: AuthenticatedActorSchema,
      attemptId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("INSPECT_EVIDENCE"),
      actor: AuthenticatedActorSchema,
      runId: IdentifierSchema,
      after: IdentifierSchema.optional(),
      limit: z.number().int().positive().max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("INSPECT_PROJECTION"),
      actor: AuthenticatedActorSchema,
      coordinationRecordId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("RESOLVE_PERSONAL_RUN_PRESET_BINDINGS"),
      actor: MemberActorSchema,
      bindings: z.record(
        IdentifierSchema,
        z
          .object({
            personalRunPresetId: IdentifierSchema,
            expectedVersion: z.number().int().positive(),
          })
          .strict(),
      ),
    })
    .strict(),
]);

export const QueryResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("INSPECT_COORDINATION_RECORD"),
      record: CoordinationRecordViewSchema,
    })
    .strict(),
  z.object({ kind: z.literal("INSPECT_RUN"), run: RunViewSchema }).strict(),
  z.object({ kind: z.literal("INSPECT_ATTEMPT"), attempt: AttemptViewSchema }).strict(),
  z
    .object({
      kind: z.literal("INSPECT_EVIDENCE"),
      evidence: z.array(EvidenceRecordSchema).max(100),
      next: IdentifierSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("INSPECT_PROJECTION"), projection: ProjectionViewSchema }).strict(),
  z
    .object({
      kind: z.literal("RESOLVE_PERSONAL_RUN_PRESET_BINDINGS"),
      bindings: z.record(
        IdentifierSchema,
        z
          .object({
            personalRunPresetId: IdentifierSchema,
            presetVersion: z.number().int().positive(),
            runtime: z.enum(["CLAUDE", "CODEX", "PI", "OPENCODE"]),
            runnerId: IdentifierSchema,
            profileVersion: z.number().int().positive(),
            host: z.enum(["NATIVE", "ORCA"]),
            interaction: z.enum(["HEADLESS", "INTERACTIVE"]),
            repositoryMode: z.enum(["INSPECT_ONLY", "MUTATING"]),
            repositoryAssurance: z.enum(["ADVISORY", "ENFORCED"]),
          })
          .strict(),
      ),
      staleKeys: z.array(IdentifierSchema),
    })
    .strict(),
]);

export type AuthorityFact = Readonly<{
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
  code: string;
  revision?: string;
  summary: string;
}>;

export type AuthorityPreviewRequest = Readonly<{
  actor: MemberActor;
  projectId: ProjectId;
  coordinationRecordId?: CoordinationRecordId;
  repository: RepositoryRequest;
  execution: ExecutionSelection;
  workflow?: WorkflowAuthorityRef;
}>;

export type AuthorityPreview = Readonly<{
  evaluatedAt: number;
  eligibleTargets: readonly import("./runners.ts").EligibleTarget[];
  requirements: readonly AuthorityFact[];
  warnings: readonly AuthorityFact[];
}>;

export const AuthorityFactSchema = z
  .object({
    subject: z.enum([
      "MEMBER",
      "RUNNER",
      "EXPOSURE",
      "PROFILE",
      "CONNECTOR",
      "APPROVAL",
      "REPOSITORY",
      "MUTATION_LEASE",
      "WORKFLOW",
      "DEADLINE",
    ]),
    outcome: z.enum(["ALLOWED", "NOT_REQUIRED", "WAITING", "DENIED"]),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    revision: z.string().min(1).max(128).optional(),
    summary: z.string().min(1).max(240),
  })
  .strict();

export const AuthorityPreviewRequestSchema = z
  .object({
    actor: MemberActorSchema,
    projectId: IdentifierSchema,
    coordinationRecordId: IdentifierSchema.optional(),
    repository: RepositoryRequestSchema,
    execution: ExecutionSelectionSchema,
    workflow: WorkflowAuthorityRefSchema.optional(),
  })
  .strict();

export const AuthorityPreviewSchema = z
  .object({
    evaluatedAt: InstantSchema,
    eligibleTargets: z.array(EligibleTargetSchema).max(256),
    requirements: z.array(AuthorityFactSchema).max(256),
    warnings: z.array(AuthorityFactSchema).max(256),
  })
  .strict();
