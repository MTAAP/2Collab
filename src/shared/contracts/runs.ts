import { z } from "zod";
import type {
  AgentRunId,
  AuthoritySessionId,
  CommitSha,
  CoordinationRecordId,
  DispatchPermitId,
  DurableCheckpointId,
  EvidenceId,
  ExecutionAttemptId,
  Instant,
  ProjectId,
  RegisteredRunnerId,
} from "./ids.ts";
import { IdentifierSchema, InstantSchema, RevisionSchema } from "./ids.ts";
import type { RepositoryAssurance, RepositoryMode } from "./runners.ts";

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

export type EvidenceRecord = Readonly<{
  id: EvidenceId;
  runId: AgentRunId;
  attemptId?: ExecutionAttemptId;
  kind: "VERIFICATION" | "PUBLISHED_REFERENCE" | "PROGRESS" | "RUN_RESULT";
  summary: string;
  createdAt: Instant;
}>;

export type DispatchPermit = Readonly<{
  id: DispatchPermitId;
  attemptId: ExecutionAttemptId;
  token: string;
  expiresAt: Instant;
}>;

export type AuthoritySessionView = Readonly<{
  id: AuthoritySessionId;
  attemptId: ExecutionAttemptId;
  fence: number;
  leaseExpiresAt: Instant;
}>;

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
    .object({ kind: z.literal("CANCELLED"), observedAt: InstantSchema, confirmed: z.boolean() })
    .strict(),
  z
    .object({ kind: z.literal("TIMED_OUT"), observedAt: InstantSchema, confirmed: z.boolean() })
    .strict(),
  z.object({ kind: z.literal("LOST"), observedAt: InstantSchema }).strict(),
]);

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
