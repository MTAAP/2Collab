import { z } from "zod";
import { CommitShaSchema, IdentifierSchema, InstantSchema, Sha256Schema } from "./ids.ts";

export const RunnerOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("LAUNCH_ATTEMPT"),
      attemptId: IdentifierSchema,
      permit: z.string().min(1).max(8_192),
    })
    .strict(),
  z.object({ kind: z.literal("CANCEL_ATTEMPT"), attemptId: IdentifierSchema }).strict(),
  z
    .object({
      kind: z.literal("EXECUTE_LOCAL_GATE"),
      gateEvaluationId: IdentifierSchema,
      gateKey: IdentifierSchema,
      repositoryRevision: CommitShaSchema,
      manifestFingerprint: Sha256Schema,
    })
    .strict(),
  z
    .object({ kind: z.literal("CANCEL_GATE_EVALUATION"), gateEvaluationId: IdentifierSchema })
    .strict(),
]);

export const RunnerFrameSchema = z
  .object({
    messageId: IdentifierSchema,
    runnerId: IdentifierSchema,
    runId: IdentifierSchema,
    attemptId: IdentifierSchema.optional(),
    issuedAt: InstantSchema,
    expiresAt: InstantSchema,
    operation: RunnerOperationSchema,
  })
  .strict();

export type RunnerFrame = Readonly<z.infer<typeof RunnerFrameSchema>>;
