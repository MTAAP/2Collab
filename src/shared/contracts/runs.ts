import { z } from "zod";
import type {
  AgentRunId,
  AuthoritySessionId,
  CommitSha,
  ConnectorId,
  CoordinationRecordId,
  DurableCheckpointId,
  EvidenceId,
  ExecutionAttemptId,
  Instant,
  MutationLeaseId,
  ProjectId,
  RegisteredRunnerId,
} from "./ids.ts";
import {
  CommitShaSchema,
  IdentifierSchema,
  InstantSchema,
  RevisionSchema,
  Sha256Schema,
} from "./ids.ts";
import type { RepositoryAssurance, RepositoryMode } from "./runners.ts";
import { GitRefSchema, RepositoryRelativePathSchema } from "./runners.ts";

export type AgentRunState = "QUEUED" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type ExecutionAttemptState =
  | "PENDING"
  | "STARTING"
  | "RUNNING"
  | "EXITED"
  | "FAILED_TO_START"
  | "CANCELLED"
  | "TIMED_OUT"
  | "LOST";
export type RunResultKind = "DELIVERED" | "NO_CHANGES" | "BLOCKED" | "ESCALATED";

export type CoordinationRecordView = Readonly<{
  id: CoordinationRecordId;
  projectId: ProjectId;
  title: string;
  revision: number;
  runIds: readonly AgentRunId[];
}>;

export type RunView = Readonly<{
  id: AgentRunId;
  coordinationRecordId: CoordinationRecordId;
  state: AgentRunState;
  goal: string;
  repositoryMode: RepositoryMode;
  repositoryAssurance: RepositoryAssurance;
  revision: number;
  attemptIds: readonly ExecutionAttemptId[];
}>;

export type AttemptView = Readonly<{
  id: ExecutionAttemptId;
  runId: AgentRunId;
  runnerId: RegisteredRunnerId;
  state: ExecutionAttemptState;
  revision: number;
}>;

export type DurableCheckpoint = Readonly<{
  id: DurableCheckpointId;
  runId: AgentRunId;
  attemptId: ExecutionAttemptId;
  reason: "HUMAN_INPUT" | "RECOVERY" | "MUTATION_LEASE_EXPIRED" | "CANCELLATION";
  requestedAction: "RESPOND" | "RESUME" | "ADOPT_FOLLOW_UP" | "NONE";
  summary: string;
  publishedCommit?: CommitSha;
  createdAt: Instant;
}>;

export type EvidenceInput = Readonly<z.infer<typeof EvidenceInputSchema>>;

export type EvidenceRecord = Readonly<{
  id: EvidenceId;
  runId: AgentRunId;
  attemptId?: ExecutionAttemptId;
  evidence: EvidenceInput;
  createdAt: Instant;
}>;

export type QueuedDispatchMetadata = Readonly<{
  state: "QUEUED";
  runnerId: RegisteredRunnerId;
  attemptId: ExecutionAttemptId;
  expiresAt: Instant;
}>;

export type TerminationRequestMetadata = Readonly<{
  state: "REQUESTED";
  attemptId: ExecutionAttemptId;
  reason: "CANCELLATION" | "TIMEOUT" | "REVOCATION" | "DEADLINE";
  requestedAt: Instant;
}>;

export type CancellationTermination =
  | Readonly<{ kind: "NO_ACTIVE_ATTEMPT" }>
  | Readonly<{ kind: "REQUEST_TERMINATION"; request: TerminationRequestMetadata }>;

type AuthoritySessionBase = Readonly<{
  id: AuthoritySessionId;
  attemptId: ExecutionAttemptId;
  fence: number;
  issuedAt: Instant;
  expiresAt: Instant;
  repositoryAssurance: RepositoryAssurance;
  connectorEpochs: Readonly<Record<ConnectorId, number>>;
}>;

export type MutationLease = Readonly<{
  leaseId: MutationLeaseId;
  fence: number;
  expiresAt: Instant;
}>;

export type AuthoritySessionView = AuthoritySessionBase &
  (
    | Readonly<{ repositoryMode: "INSPECT_ONLY"; mutationLease?: never }>
    | Readonly<{ repositoryMode: "MUTATING"; mutationLease?: MutationLease }>
  );

export type ProjectionView = Readonly<{
  record: CoordinationRecordView;
  runs: readonly RunView[];
  attempts: readonly AttemptView[];
}>;

export const AttemptEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ACKNOWLEDGED"), observedAt: InstantSchema }).strict(),
  z.object({ kind: z.literal("PROCESS_STARTED"), observedAt: InstantSchema }).strict(),
  z
    .object({
      kind: z.literal("PROCESS_EXITED"),
      observedAt: InstantSchema,
      exitCode: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("FAILED_TO_START"),
      observedAt: InstantSchema,
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("TERMINATION_REQUESTED"),
      reason: z.enum(["CANCELLATION", "TIMEOUT", "REVOCATION", "DEADLINE"]),
      observedAt: InstantSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("CANCELLED"),
      observedAt: InstantSchema,
      confirmation: z.enum(["PROCESS_TERMINATED", "PROCESS_NOT_STARTED"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("TIMED_OUT"),
      observedAt: InstantSchema,
      confirmation: z.literal("PROCESS_TERMINATED"),
    })
    .strict(),
  z.object({ kind: z.literal("LOST"), observedAt: InstantSchema }).strict(),
]);

const SafeSummarySchema = z.string().min(1).max(2_048);
const ConnectorEpochsSchema = z
  .record(IdentifierSchema, RevisionSchema)
  .refine((epochs) => Object.keys(epochs).length <= 32, "At most 32 connector epochs are allowed");

export const EvidenceInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("PUBLISHED_GIT_REFERENCE"),
      remoteIdentity: z.string().min(1).max(128),
      remoteRef: GitRefSchema,
      commitSha: CommitShaSchema,
      verifiedAt: InstantSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("DIFF_STATS"),
      baseCommit: CommitShaSchema,
      headCommit: CommitShaSchema,
      dirty: z.boolean(),
      filesChanged: z.number().int().nonnegative().max(100_000),
      additions: z.number().int().nonnegative().max(10_000_000),
      deletions: z.number().int().nonnegative().max(10_000_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("CHANGED_PATHS"),
      baseCommit: CommitShaSchema,
      observedAt: InstantSchema,
      paths: z.array(RepositoryRelativePathSchema).max(2_048),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("GATE_EVALUATION"),
      gateEvaluationId: IdentifierSchema,
      gateKey: IdentifierSchema,
      repositoryRevision: CommitShaSchema,
      manifestFingerprint: Sha256Schema,
      outcome: z.enum(["PASSED", "FAILED", "TIMED_OUT", "CANCELLED"]),
      evidenceRevision: RevisionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("VERIFICATION"),
      name: z.string().min(1).max(120),
      outcome: z.enum(["PASSED", "FAILED", "SKIPPED"]),
      durationMs: z.number().int().nonnegative().max(86_400_000),
      summary: SafeSummarySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("ATTEMPT_OUTCOME"),
      outcome: z.enum(["CONTINUE", "GOAL_ACHIEVED", "ESCALATE"]),
      reason: SafeSummarySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("CLEANUP"),
      disposition: z.enum(["REMOVED", "RETAINED_LOCAL_WORK", "FAILED"]),
      trackedClean: z.boolean(),
      untrackedClean: z.boolean(),
      publishedCommit: CommitShaSchema.optional(),
    })
    .strict(),
]);

export const CoordinationRecordViewSchema = z
  .object({
    id: IdentifierSchema,
    projectId: IdentifierSchema,
    title: z.string().min(1).max(160),
    revision: RevisionSchema,
    runIds: z.array(IdentifierSchema).max(1_024),
  })
  .strict();

export const AttemptViewSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    runnerId: IdentifierSchema,
    state: z.enum([
      "PENDING",
      "STARTING",
      "RUNNING",
      "EXITED",
      "FAILED_TO_START",
      "CANCELLED",
      "TIMED_OUT",
      "LOST",
    ]),
    revision: RevisionSchema,
  })
  .strict();

export const QueuedDispatchMetadataSchema = z
  .object({
    state: z.literal("QUEUED"),
    runnerId: IdentifierSchema,
    attemptId: IdentifierSchema,
    expiresAt: InstantSchema,
  })
  .strict();

export const TerminationRequestMetadataSchema = z
  .object({
    state: z.literal("REQUESTED"),
    attemptId: IdentifierSchema,
    reason: z.enum(["CANCELLATION", "TIMEOUT", "REVOCATION", "DEADLINE"]),
    requestedAt: InstantSchema,
  })
  .strict();

export const CancellationTerminationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("NO_ACTIVE_ATTEMPT") }).strict(),
  z
    .object({
      kind: z.literal("REQUEST_TERMINATION"),
      request: TerminationRequestMetadataSchema,
    })
    .strict(),
]);

const AuthoritySessionBaseSchema = z.object({
  id: IdentifierSchema,
  attemptId: IdentifierSchema,
  fence: RevisionSchema,
  issuedAt: InstantSchema,
  expiresAt: InstantSchema,
  repositoryAssurance: z.enum(["ADVISORY", "ENFORCED"]),
  connectorEpochs: ConnectorEpochsSchema,
});
const MutationLeaseSchema = z
  .object({ leaseId: IdentifierSchema, fence: RevisionSchema, expiresAt: InstantSchema })
  .strict();

export const AuthoritySessionViewSchema = z.discriminatedUnion("repositoryMode", [
  AuthoritySessionBaseSchema.extend({ repositoryMode: z.literal("INSPECT_ONLY") }).strict(),
  AuthoritySessionBaseSchema.extend({
    repositoryMode: z.literal("MUTATING"),
    mutationLease: MutationLeaseSchema.optional(),
  }).strict(),
]);

export const EvidenceRecordSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    attemptId: IdentifierSchema.optional(),
    evidence: EvidenceInputSchema,
    createdAt: InstantSchema,
  })
  .strict();

export const DurableCheckpointSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    attemptId: IdentifierSchema,
    reason: z.enum(["HUMAN_INPUT", "RECOVERY", "MUTATION_LEASE_EXPIRED", "CANCELLATION"]),
    requestedAction: z.enum(["RESPOND", "RESUME", "ADOPT_FOLLOW_UP", "NONE"]),
    summary: SafeSummarySchema,
    publishedCommit: CommitShaSchema.optional(),
    createdAt: InstantSchema,
  })
  .strict();

export const RunViewSchema = z
  .object({
    id: IdentifierSchema,
    coordinationRecordId: IdentifierSchema,
    state: z.enum(["QUEUED", "RUNNING", "WAITING", "COMPLETED", "FAILED", "CANCELLED"]),
    goal: z.string().min(1).max(16_384),
    repositoryMode: z.enum(["MUTATING", "INSPECT_ONLY"]),
    repositoryAssurance: z.enum(["ADVISORY", "ENFORCED"]),
    revision: RevisionSchema,
    attemptIds: z.array(IdentifierSchema).max(1_024),
  })
  .strict();

export const ProjectionViewSchema = z
  .object({
    record: CoordinationRecordViewSchema,
    runs: z.array(RunViewSchema).max(1_024),
    attempts: z.array(AttemptViewSchema).max(4_096),
  })
  .strict();
