import { z } from "zod";
import type { AuthenticatedActor, MemberActor } from "./actors.ts";
import { AuthenticatedActorSchema } from "./actors.ts";
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
  RetainedLocalWorkId,
  RunnerConnectionId,
  Sha256,
  TeamDispatchExposureId,
} from "./ids.ts";
import { CommitShaSchema, IdentifierSchema, RevisionSchema, Sha256Schema } from "./ids.ts";
import type { EffectiveRunConfigurationRef } from "./presets.ts";
import { EffectiveRunConfigurationRefSchema } from "./presets.ts";
import type {
  AttemptView,
  AuthoritySessionView,
  CoordinationRecordView,
  DispatchPermit,
  DurableCheckpoint,
  EvidenceRecord,
  ProjectionView,
  RunResultKind,
  RunView,
} from "./runs.ts";
import { AttemptEventSchema } from "./runs.ts";
import type { ExecutionSelection, RepositoryRequest, RunnerPolicyReplacement } from "./runners.ts";
import { ExecutionSelectionSchema, RepositoryRequestSchema } from "./runners.ts";

export type CommandBase = Readonly<{
  idempotencyKey: IdempotencyKey;
  actor: AuthenticatedActor;
}>;

export type WorkflowAuthorityRef = Readonly<{
  workflowExecutionId: string;
  stepOccurrenceId: string;
  workflowRevision: number;
  effectiveConfigurationDigest: Sha256;
}>;

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

export type AcceptAttemptEvent = CommandBase &
  Readonly<{
    kind: "ACCEPT_ATTEMPT_EVENT";
    runId: AgentRunId;
    expectedRunRevision: number;
    attemptId: ExecutionAttemptId;
    expectedAttemptRevision: number;
    event: z.infer<typeof AttemptEventSchema>;
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
    publishedCommit?: CommitSha;
  }>;

export type RecordEvidence = CommandBase &
  Readonly<{
    kind: "RECORD_EVIDENCE";
    runId: AgentRunId;
    expectedRunRevision: number;
    attemptId?: ExecutionAttemptId;
    evidenceKind: EvidenceRecord["kind"];
    summary: string;
  }>;

export type RecordRunResult = CommandBase &
  Readonly<{
    kind: "RECORD_RUN_RESULT";
    runId: AgentRunId;
    expectedRunRevision: number;
    attemptId: ExecutionAttemptId;
    result: RunResultKind;
    summary: string;
    evidenceIds: readonly EvidenceId[];
  }>;

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
    collidingRunId: AgentRunId;
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
  | "COMMENT"
  | "SET_LABELS"
  | "SET_ASSIGNEES"
  | "SET_MILESTONE"
  | "SET_STATE";
export type OutlineMutationKind =
  | "CREATE_DOCUMENT"
  | "EDIT_DOCUMENT"
  | "ADD_COMMENT"
  | "ARCHIVE_DOCUMENT";

export type SensitiveOperation =
  | Readonly<{ kind: "MUTATE_REPOSITORY"; expectedHead: CommitSha }>
  | Readonly<{ kind: "PUBLISH_GIT_REFERENCE"; expectedHead: CommitSha; remoteRef: string }>
  | Readonly<{
      kind: "MUTATE_GITHUB";
      connectorId: ConnectorId;
      connectorEpoch: number;
      resourceId: string;
      expectedRevision: string;
      mutation: GitHubMutationKind;
    }>
  | Readonly<{
      kind: "MUTATE_OUTLINE";
      connectorId: ConnectorId;
      connectorEpoch: number;
      documentId: string;
      expectedRevision: string;
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
    }>
  | Readonly<{ kind: "DISCARD_RETAINED_WORK"; retainedWorkId: RetainedLocalWorkId }>;

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

export type CoordinationQuery =
  | InspectCoordinationRecord
  | InspectRun
  | InspectAttempt
  | InspectEvidence
  | InspectProjection;

export type CommandResult =
  | Readonly<{
      kind: "LAUNCH_RUN";
      record: CoordinationRecordView;
      run: RunView;
      attempt: AttemptView;
      permit: DispatchPermit;
    }>
  | Readonly<{
      kind: "AUTHORIZE_ATTEMPT";
      run: RunView;
      attempt: AttemptView;
      permit: DispatchPermit;
    }>
  | Readonly<{ kind: "CANCEL_RUN"; run: RunView }>
  | Readonly<{ kind: "ACCEPT_ATTEMPT_EVENT"; run: RunView; attempt: AttemptView }>
  | Readonly<{ kind: "RECORD_CHECKPOINT"; checkpoint: DurableCheckpoint; run: RunView }>
  | Readonly<{ kind: "RECORD_EVIDENCE"; evidence: EvidenceRecord }>
  | Readonly<{ kind: "RECORD_RUN_RESULT"; run: RunView }>
  | Readonly<{ kind: "LINK_SOURCE_REFERENCE"; record: CoordinationRecordView }>
  | Readonly<{ kind: "ACKNOWLEDGE_COLLISION"; record: CoordinationRecordView }>
  | Readonly<{ kind: "CONSUME_PERMIT"; session: AuthoritySessionView }>
  | Readonly<{ kind: "RENEW_AUTHORITY_SESSION"; session: AuthoritySessionView }>
  | Readonly<{ kind: "AUTHORIZE_OPERATION"; authorizationId: string; expiresAt: number }>
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
  | Readonly<{ kind: "INSPECT_PROJECTION"; projection: ProjectionView }>;

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

const SensitiveOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("MUTATE_REPOSITORY"), expectedHead: CommitShaSchema }).strict(),
  z
    .object({
      kind: z.literal("PUBLISH_GIT_REFERENCE"),
      expectedHead: CommitShaSchema,
      remoteRef: z.string().min(1).max(255),
    })
    .strict(),
  z
    .object({
      kind: z.literal("MUTATE_GITHUB"),
      connectorId: IdentifierSchema,
      connectorEpoch: RevisionSchema,
      resourceId: z.string().min(1).max(256),
      expectedRevision: z.string().min(1).max(128),
      mutation: z.enum([
        "CREATE_ISSUE",
        "EDIT_ISSUE",
        "COMMENT",
        "SET_LABELS",
        "SET_ASSIGNEES",
        "SET_MILESTONE",
        "SET_STATE",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("MUTATE_OUTLINE"),
      connectorId: IdentifierSchema,
      connectorEpoch: RevisionSchema,
      documentId: z.string().min(1).max(256),
      expectedRevision: z.string().min(1).max(128),
      mutation: z.enum(["CREATE_DOCUMENT", "EDIT_DOCUMENT", "ADD_COMMENT", "ARCHIVE_DOCUMENT"]),
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
  z.object({ kind: z.literal("DISCARD_RETAINED_WORK"), retainedWorkId: IdentifierSchema }).strict(),
]);

export const CollabCommandSchema = z.discriminatedUnion("kind", [
  CommandBaseSchema.extend({
    kind: z.literal("LAUNCH_RUN"),
    projectId: IdentifierSchema,
    coordination: CoordinationSelectionSchema,
    goal: z.string().min(1).max(16_384),
    repository: RepositoryRequestSchema,
    execution: ExecutionSelectionSchema,
    effectiveConfiguration: EffectiveRunConfigurationRefSchema,
    workflow: z
      .object({
        workflowExecutionId: IdentifierSchema,
        stepOccurrenceId: IdentifierSchema,
        workflowRevision: RevisionSchema,
        effectiveConfigurationDigest: Sha256Schema,
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
    kind: z.literal("ACCEPT_ATTEMPT_EVENT"),
    ...RevisionedRunSchema,
    attemptId: IdentifierSchema,
    expectedAttemptRevision: RevisionSchema,
    event: AttemptEventSchema,
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("RECORD_CHECKPOINT"),
    ...RevisionedRunSchema,
    attemptId: IdentifierSchema,
    reason: z.enum(["HUMAN_INPUT", "RECOVERY", "MUTATION_LEASE_EXPIRED", "CANCELLATION"]),
    requestedAction: z.enum(["RESPOND", "RESUME", "ADOPT_FOLLOW_UP", "NONE"]),
    summary: z.string().min(1).max(2_048),
    publishedCommit: CommitShaSchema.optional(),
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("RECORD_EVIDENCE"),
    ...RevisionedRunSchema,
    attemptId: IdentifierSchema.optional(),
    evidenceKind: z.enum(["VERIFICATION", "PUBLISHED_REFERENCE", "PROGRESS", "RUN_RESULT"]),
    summary: z.string().min(1).max(2_048),
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("RECORD_RUN_RESULT"),
    ...RevisionedRunSchema,
    attemptId: IdentifierSchema,
    result: z.enum(["DELIVERED", "NO_CHANGES", "BLOCKED", "ESCALATED"]),
    summary: z.string().min(1).max(2_048),
    evidenceIds: z.array(IdentifierSchema).max(128),
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
    collidingRunId: IdentifierSchema,
    reason: z.string().min(1).max(240),
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("CONSUME_PERMIT"),
    permit: z.string().min(1).max(8_192),
    runnerId: IdentifierSchema,
    runnerEpoch: RevisionSchema,
    connectionId: IdentifierSchema,
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("RENEW_AUTHORITY_SESSION"),
    sessionId: IdentifierSchema,
    sessionFence: RevisionSchema,
    runnerEpoch: RevisionSchema,
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("AUTHORIZE_OPERATION"),
    sessionId: IdentifierSchema,
    sessionFence: RevisionSchema,
    operation: SensitiveOperationSchema,
  }).strict(),
  CommandBaseSchema.extend({
    kind: z.literal("RELEASE_AUTHORITY_SESSION"),
    sessionId: IdentifierSchema,
    sessionFence: RevisionSchema,
    reason: z.enum(["ATTEMPT_EXITED", "CHECKPOINTED", "CANCELLED", "TIMED_OUT"]),
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
