import { z } from "zod";
import {
  AcceptAttemptEventPayloadSchema,
  AuthorizeOperationPayloadSchema,
  ConsumePermitPayloadSchema,
  RecordCheckpointPayloadSchema,
  RecordEvidencePayloadSchema,
  RecordRunResultPayloadSchema,
  ReleaseAuthoritySessionPayloadSchema,
  RenewAuthoritySessionPayloadSchema,
  SemanticContinuitySchema,
} from "./commands.ts";
import { ReferenceFirstBootstrapEnvelopeSchema } from "./context.ts";
import { CommitShaSchema, IdentifierSchema, InstantSchema, Sha256Schema } from "./ids.ts";
import { EffectiveInstructionEnvelopeSchema } from "./presets.ts";
import { RetryDispositionSchema } from "./result.ts";
import { AuthoritySessionViewSchema } from "./runs.ts";

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

export const ServerWelcomeSchema = z
  .object({
    kind: z.literal("SERVER_WELCOME"),
    selectedVersion: z.string().regex(/^[1-9][0-9]{0,2}\.(?:0|[1-9][0-9]{0,2})$/),
    connectionId: IdentifierSchema,
    fence: z.number().int().positive(),
    limits: z
      .object({
        maximumFrameBytes: z.literal(65_536),
        runnerFramesPerSecond: z.literal(100),
        runnerBurst: z.literal(200),
        runFramesPerSecond: z.literal(50),
        runBurst: z.literal(100),
        sendQueueItems: z.literal(1_024),
        sendQueueBytes: z.literal(1024 * 1024),
        heartbeatSeconds: z.literal(10),
        offlineSeconds: z.literal(30),
        operationAckSeconds: z.literal(10),
        outputChunkBytes: z.literal(16 * 1024),
        reconnectBufferBytes: z.literal(1024 * 1024),
        reconnectBackoffSeconds: z.literal(30),
      })
      .strict(),
  })
  .strict();

export const RunnerMessageBodySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("HEARTBEAT"),
      repositoryObservations: z
        .array(
          z
            .object({
              projectId: IdentifierSchema,
              mappingRevision: z.number().int().positive(),
              baseBranch: z.string().min(1).max(255),
              baseCommit: CommitShaSchema,
            })
            .strict(),
        )
        .max(128)
        .default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("OPERATION_ACKNOWLEDGEMENT"),
      eventId: IdentifierSchema,
      deliveryId: IdentifierSchema,
      semanticDigest: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("CONSUME_DISPATCH_PERMIT"),
      eventId: IdentifierSchema,
      requestId: IdentifierSchema,
      payload: ConsumePermitPayloadSchema.omit({
        runnerId: true,
        runnerEpoch: true,
        connectionId: true,
      }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("RENEW_AUTHORITY_SESSION"),
      eventId: IdentifierSchema,
      requestId: IdentifierSchema,
      payload: RenewAuthoritySessionPayloadSchema.omit({ runnerEpoch: true }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("RELEASE_AUTHORITY_SESSION"),
      eventId: IdentifierSchema,
      requestId: IdentifierSchema,
      payload: ReleaseAuthoritySessionPayloadSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("AUTHORIZE_OPERATION"),
      eventId: IdentifierSchema,
      requestId: IdentifierSchema,
      payload: AuthorizeOperationPayloadSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("ATTEMPT_EVENT"),
      eventId: IdentifierSchema,
      payload: AcceptAttemptEventPayloadSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("CHECKPOINT"),
      eventId: IdentifierSchema,
      payload: RecordCheckpointPayloadSchema.omit({ runnerId: true }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("EVIDENCE"),
      eventId: IdentifierSchema,
      payload: RecordEvidencePayloadSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("RUN_RESULT"),
      eventId: IdentifierSchema,
      payload: RecordRunResultPayloadSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("GATE_EVENT"),
      eventId: IdentifierSchema,
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
      instructions: EffectiveInstructionEnvelopeSchema,
      bootstrap: ReferenceFirstBootstrapEnvelopeSchema,
      projectMappingRevision: z.number().int().positive(),
      repositoryMode: z.enum(["INSPECT_ONLY", "MUTATING"]),
      repositoryAssurance: z.enum(["ADVISORY", "ENFORCED"]),
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
      result: z.discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("CONSUME_PERMIT"), session: AuthoritySessionViewSchema })
          .strict(),
        z
          .object({
            kind: z.literal("RENEW_AUTHORITY_SESSION"),
            session: AuthoritySessionViewSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("AUTHORIZE_OPERATION"),
            authorizationId: IdentifierSchema,
            operationDigest: Sha256Schema,
            expiresAt: InstantSchema,
          })
          .strict(),
        z
          .object({ kind: z.literal("RELEASE_AUTHORITY_SESSION"), released: z.literal(true) })
          .strict(),
        z
          .object({
            kind: z.literal("ERROR"),
            code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
            retry: RetryDispositionSchema,
          })
          .strict(),
      ]),
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
  .object({
    ...EnvelopeBase,
    body: RunnerMessageBodySchema,
    semanticContinuity: SemanticContinuitySchema.optional(),
  })
  .strict();
export const ServerEnvelopeSchema = z
  .object({ ...EnvelopeBase, body: ServerMessageBodySchema })
  .strict();

export type ClientHello = Readonly<z.infer<typeof ClientHelloSchema>>;
export type ServerWelcome = Readonly<z.infer<typeof ServerWelcomeSchema>>;
export type RunnerEnvelope = Readonly<z.infer<typeof RunnerEnvelopeSchema>>;
export type ServerEnvelope = Readonly<z.infer<typeof ServerEnvelopeSchema>>;
