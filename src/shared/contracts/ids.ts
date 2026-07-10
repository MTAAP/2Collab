import { z } from "zod";

declare const brand: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type Instant = Brand<number, "Instant">;
export type Sha256 = Brand<string, "Sha256">;
export type CommitSha = Brand<string, "CommitSha">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;
export type TeamId = Brand<string, "TeamId">;
export type MemberId = Brand<string, "MemberId">;
export type SessionId = Brand<string, "SessionId">;
export type ProjectId = Brand<string, "ProjectId">;
export type ConnectorId = Brand<string, "ConnectorId">;
export type ConnectedRepositoryId = Brand<string, "ConnectedRepositoryId">;
export type CoordinationRecordId = Brand<string, "CoordinationRecordId">;
export type AgentRunId = Brand<string, "AgentRunId">;
export type ExecutionAttemptId = Brand<string, "ExecutionAttemptId">;
export type DurableCheckpointId = Brand<string, "DurableCheckpointId">;
export type EvidenceId = Brand<string, "EvidenceId">;
export type WorkflowExecutionId = Brand<string, "WorkflowExecutionId">;
export type RegisteredRunnerId = Brand<string, "RegisteredRunnerId">;
export type RunnerConnectionId = Brand<string, "RunnerConnectionId">;
export type CustomLaunchProfileVersionId = Brand<string, "CustomLaunchProfileVersionId">;
export type TeamDispatchExposureId = Brand<string, "TeamDispatchExposureId">;
export type DispatchPermitId = Brand<string, "DispatchPermitId">;
export type AuthoritySessionId = Brand<string, "AuthoritySessionId">;
export type ApprovalSubjectId = Brand<string, "ApprovalSubjectId">;
export type GateEvaluationId = Brand<string, "GateEvaluationId">;
export type RetainedLocalWorkId = Brand<string, "RetainedLocalWorkId">;
export type ProjectionCursor = Brand<string, "ProjectionCursor">;

export const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const RevisionSchema = z.number().int().nonnegative();
export const InstantSchema = z.number().int().nonnegative();
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const CommitShaSchema = z.string().regex(/^[a-f0-9]{7,64}$/);
