import { z } from "zod";
import { CoordinationSelectionSchema } from "./context.ts";
import { IdentifierSchema, InstantSchema, RevisionSchema } from "./ids.ts";
import type { Result } from "./result.ts";
import { DomainErrorSchema } from "./result.ts";
import { GitRefSchema } from "./runners.ts";
import { CoordinationRecordViewSchema, RunViewSchema } from "./runs.ts";

export const PublicPresetRefSchema = z
  .object({
    presetId: IdentifierSchema,
    presetVersion: RevisionSchema,
  })
  .strict();

const PublicRepositorySelectionSchema = z
  .object({
    repositoryId: z.string().min(1).max(256),
    intendedBranch: GitRefSchema.optional(),
  })
  .strict();

export const PublicCreateRunRequestSchema = z
  .object({
    idempotencyKey: IdentifierSchema,
    projectId: IdentifierSchema,
    coordination: CoordinationSelectionSchema,
    goal: z.string().trim().min(1).max(16_384),
    repository: PublicRepositorySelectionSchema,
    preset: PublicPresetRefSchema,
  })
  .strict();

export const PublicInspectRunRequestSchema = z.object({ runId: IdentifierSchema }).strict();

export const PublicCancelRunRequestSchema = z
  .object({
    idempotencyKey: IdentifierSchema,
    runId: IdentifierSchema,
    expectedRunRevision: RevisionSchema,
  })
  .strict();

export const PublicResumeRunRequestSchema = z
  .object({
    idempotencyKey: IdentifierSchema,
    runId: IdentifierSchema,
    expectedRunRevision: RevisionSchema,
    checkpointId: IdentifierSchema,
    preset: PublicPresetRefSchema.optional(),
  })
  .strict();

export const PublicInspectEvidenceRequestSchema = z
  .object({
    runId: IdentifierSchema,
    after: IdentifierSchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const PublicAttemptViewSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
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

const PublicEvidenceSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema,
    attemptId: IdentifierSchema.optional(),
    kind: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    summary: z.string().max(2_048).optional(),
    createdAt: InstantSchema,
  })
  .strict();

const PublicTerminationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("NO_ACTIVE_ATTEMPT") }).strict(),
  z
    .object({
      kind: z.literal("REQUEST_TERMINATION"),
      attemptId: IdentifierSchema,
      reason: z.enum(["CANCELLATION", "TIMEOUT", "REVOCATION", "DEADLINE"]),
      requestedAt: InstantSchema,
    })
    .strict(),
]);

export const PublicRunResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("CREATE_RUN"),
      record: CoordinationRecordViewSchema,
      run: RunViewSchema,
      attempt: PublicAttemptViewSchema,
    })
    .strict(),
  z.object({ kind: z.literal("INSPECT_RUN"), run: RunViewSchema }).strict(),
  z
    .object({
      kind: z.literal("CANCEL_RUN"),
      run: RunViewSchema,
      termination: PublicTerminationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("RESUME_RUN"),
      decision: z.discriminatedUnion("outcome", [
        z
          .object({
            outcome: z.literal("AUTHORIZED"),
            run: RunViewSchema,
            attempt: PublicAttemptViewSchema,
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
      kind: z.literal("INSPECT_EVIDENCE"),
      evidence: z.array(PublicEvidenceSchema).max(100),
      next: IdentifierSchema.optional(),
    })
    .strict(),
]);

export const PublicRunOperationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: PublicRunResultSchema }).strict(),
  z.object({ ok: z.literal(false), error: DomainErrorSchema }).strict(),
]);

export type PublicCreateRunRequest = Readonly<z.infer<typeof PublicCreateRunRequestSchema>>;
export type PublicInspectRunRequest = Readonly<z.infer<typeof PublicInspectRunRequestSchema>>;
export type PublicCancelRunRequest = Readonly<z.infer<typeof PublicCancelRunRequestSchema>>;
export type PublicResumeRunRequest = Readonly<z.infer<typeof PublicResumeRunRequestSchema>>;
export type PublicInspectEvidenceRequest = Readonly<
  z.infer<typeof PublicInspectEvidenceRequestSchema>
>;
export type PublicRunResult = Readonly<z.infer<typeof PublicRunResultSchema>>;
export type PublicRunOperationResult = Readonly<z.infer<typeof PublicRunOperationResultSchema>>;

type PublicResultOf<K extends PublicRunResult["kind"]> = Result<
  Extract<PublicRunResult, { kind: K }>
>;

export interface PublicRunClient {
  create(request: PublicCreateRunRequest): Promise<PublicResultOf<"CREATE_RUN">>;
  inspect(request: PublicInspectRunRequest): Promise<PublicResultOf<"INSPECT_RUN">>;
  cancel(request: PublicCancelRunRequest): Promise<PublicResultOf<"CANCEL_RUN">>;
  resume(request: PublicResumeRunRequest): Promise<PublicResultOf<"RESUME_RUN">>;
  evidence(request: PublicInspectEvidenceRequest): Promise<PublicResultOf<"INSPECT_EVIDENCE">>;
}
