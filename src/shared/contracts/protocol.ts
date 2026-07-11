import { z } from "zod";
import { CommitShaSchema, IdentifierSchema, InstantSchema, Sha256Schema } from "./ids.ts";
import { BootstrapEnvelopeSchema } from "./context.ts";

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

export const ProtocolRangeSchema = z
  .object({
    major: z.number().int().min(1).max(255),
    minimumMinor: z.number().int().min(0).max(255),
    maximumMinor: z.number().int().min(0).max(255),
  })
  .strict()
  .refine((range) => range.minimumMinor <= range.maximumMinor);

export const ClientHelloSchema = z
  .object({
    kind: z.literal("CLIENT_HELLO"),
    ranges: z.array(ProtocolRangeSchema).min(1).max(8),
  })
  .strict()
  .superRefine((hello, context) => {
    const majors = new Set<number>();
    for (const range of hello.ranges) {
      if (majors.has(range.major)) {
        context.addIssue({ code: "custom", message: "duplicate major" });
        return;
      }
      majors.add(range.major);
    }
  });

export const RunnerMessageBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("HEARTBEAT") }).strict(),
  z
    .object({
      kind: z.literal("OPERATION_ACKNOWLEDGEMENT"),
      deliveryId: IdentifierSchema,
      semanticDigest: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("CONSUME_DISPATCH_PERMIT"),
      attemptId: IdentifierSchema,
      permit: z.string().min(32).max(8_192),
    })
    .strict(),
  z
    .object({
      kind: z.literal("RENEW_AUTHORITY_SESSION"),
      attemptId: IdentifierSchema,
      expectedFence: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("RELEASE_AUTHORITY_SESSION"),
      attemptId: IdentifierSchema,
      expectedFence: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("AUTHORIZE_OPERATION"),
      attemptId: IdentifierSchema,
      requestId: IdentifierSchema,
      operationDigest: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("ATTEMPT_EVENT"),
      attemptId: IdentifierSchema,
      event: z.enum(["PROCESS_STARTED", "PROCESS_EXITED", "TERMINATION_CONFIRMED"]),
      observedAt: InstantSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("CHECKPOINT"),
      attemptId: IdentifierSchema,
      checkpointId: IdentifierSchema,
      sequence: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("EVIDENCE"),
      attemptId: IdentifierSchema,
      evidenceId: IdentifierSchema,
      evidenceKind: z.enum(["GIT_REFERENCE", "CHANGED_PATHS", "GATE_RESULT"]),
      digest: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("RUN_RESULT"),
      attemptId: IdentifierSchema,
      resultDigest: Sha256Schema,
      disposition: z.enum(["SUCCEEDED", "FAILED", "CANCELLED"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("GATE_EVENT"),
      gateEvaluationId: IdentifierSchema,
      event: z.enum(["STARTED", "COMPLETED", "TERMINATED"]),
      observedAt: InstantSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("HEADLESS_OUTPUT_CHUNK"),
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("ATTEMPT"), attemptId: IdentifierSchema }).strict(),
        z.object({ kind: z.literal("GATE"), gateEvaluationId: IdentifierSchema }).strict(),
      ]),
      stream: z.enum(["STDOUT", "STDERR"]),
      sequence: z.number().int().nonnegative(),
      redactionVersion: z.number().int().positive(),
      text: z.string().max(16_384),
      truncated: z.boolean(),
    })
    .strict(),
]);

export const ServerMessageBodySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("LAUNCH_ATTEMPT"),
      deliveryId: IdentifierSchema,
      semanticDigest: Sha256Schema,
      runId: IdentifierSchema,
      attemptId: IdentifierSchema,
      dispatchPermit: z.string().min(32).max(8_192),
      goal: z.string().min(1).max(16_384),
      bootstrap: BootstrapEnvelopeSchema,
      projectMappingRevision: z.number().int().positive(),
      repositoryMode: z.enum(["INSPECT_ONLY", "MUTATING"]),
      repositoryAssurance: z.enum(["ADVISORY", "STRICT"]),
      baseRevision: CommitShaSchema,
      host: z.enum(["NATIVE", "ORCA"]),
      interaction: z.enum(["HEADLESS", "INTERACTIVE"]),
      profileVersionId: IdentifierSchema,
      profileFingerprint: Sha256Schema,
      policyExpiresAt: InstantSchema,
      deadlineAt: InstantSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("CANCEL_ATTEMPT"),
      deliveryId: IdentifierSchema,
      semanticDigest: Sha256Schema,
      attemptId: IdentifierSchema,
      reason: z.enum(["CANCELLATION", "REVOCATION", "DEADLINE", "SHUTDOWN"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("EXECUTE_LOCAL_GATE"),
      deliveryId: IdentifierSchema,
      semanticDigest: Sha256Schema,
      gateEvaluationId: IdentifierSchema,
      gateKey: IdentifierSchema,
      repositoryRevision: CommitShaSchema,
      manifestFingerprint: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("CANCEL_GATE_EVALUATION"),
      deliveryId: IdentifierSchema,
      semanticDigest: Sha256Schema,
      gateEvaluationId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("AUTHORITY_RESPONSE"),
      requestId: IdentifierSchema,
      disposition: z.enum(["AUTHORIZED", "DENIED", "STALE"]),
      authorizationId: IdentifierSchema.optional(),
      expiresAt: InstantSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("SEMANTIC_EVENT_ACK"),
      eventId: IdentifierSchema,
      disposition: z.enum(["APPLIED", "DUPLICATE", "REJECTED"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("HEARTBEAT_ACK"),
      receivedAt: InstantSchema,
      nextHeartbeatAt: InstantSchema,
    })
    .strict(),
]);

const EnvelopeBase = {
  protocolVersion: z.string().regex(/^[1-9][0-9]{0,2}\.(?:0|[1-9][0-9]{0,2})$/),
  messageId: IdentifierSchema,
  sequence: z.number().int().positive(),
  issuedAt: InstantSchema,
  expiresAt: InstantSchema,
} as const;

export const RunnerEnvelopeSchema = z
  .object({ ...EnvelopeBase, body: RunnerMessageBodySchema })
  .strict();
export const ServerEnvelopeSchema = z
  .object({ ...EnvelopeBase, body: ServerMessageBodySchema })
  .strict();

export type ClientHello = Readonly<z.infer<typeof ClientHelloSchema>>;
export type RunnerEnvelope = Readonly<z.infer<typeof RunnerEnvelopeSchema>>;
export type ServerEnvelope = Readonly<z.infer<typeof ServerEnvelopeSchema>>;
