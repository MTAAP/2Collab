import { z } from "zod";
import { IdentifierSchema, InstantSchema } from "./ids.ts";

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
      manifestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
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
