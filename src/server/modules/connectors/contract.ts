import { z } from "zod";
import type { ConnectorId, ProjectId, Sha256 } from "../../../shared/contracts/ids.ts";
import {
  IdentifierSchema,
  InstantSchema,
  RevisionSchema,
  Sha256Schema,
} from "../../../shared/contracts/ids.ts";
import type { Result } from "../../../shared/contracts/result.ts";

const BoundedReferenceSchema = z.string().min(1).max(256);
const BoundedRevisionSchema = z.string().min(1).max(128);
const OperationSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/);

export type ContextReference = string;
export type ConnectorScope = Readonly<{
  projectId: ProjectId;
  connectorId: ConnectorId;
  connectorEpoch: number;
  references: readonly ContextReference[];
  operations: readonly string[];
}>;

export const ConnectorScopeSchema = z
  .object({
    projectId: IdentifierSchema,
    connectorId: IdentifierSchema,
    connectorEpoch: RevisionSchema.refine((value) => value > 0),
    references: z.array(BoundedReferenceSchema).min(1).max(512),
    operations: z
      .array(OperationSchema.refine((value) => value !== "*"))
      .min(1)
      .max(128),
  })
  .strict();

export type ObservationProvenance = Readonly<{
  projectId: ProjectId;
  connectorId: ConnectorId;
  connectorEpoch: number;
  kind: "WEBHOOK" | "RECONCILIATION" | "MUTATION_CONFIRMATION";
  providerActorId?: string;
}>;

export type Observed<T> = Readonly<{
  value: T;
  reference: ContextReference;
  sourceRevision: string;
  comparableDigest: Sha256;
  projectionRevision: number;
  observedAt: number;
  sourceUpdatedAt?: number;
  freshness: "FRESH" | "STALE" | "UNAVAILABLE" | "REDACTED";
  provenance: ObservationProvenance;
  consistency?: "ATOMIC" | "RESIDUAL_RACE";
}>;

export type EphemeralObserved<T> = Readonly<{
  value: T;
  reference: ContextReference;
  sourceRevision: string;
  observedAt: number;
  freshness: "FRESH" | "STALE" | "UNAVAILABLE" | "REDACTED";
  persistence: "EPHEMERAL_ONLY";
}>;

export function EphemeralObservedSchema<T extends z.ZodType>(valueSchema: T) {
  return z
    .object({
      value: valueSchema,
      reference: BoundedReferenceSchema,
      sourceRevision: BoundedRevisionSchema,
      observedAt: InstantSchema,
      freshness: z.enum(["FRESH", "STALE", "UNAVAILABLE", "REDACTED"]),
      persistence: z.literal("EPHEMERAL_ONLY").default("EPHEMERAL_ONLY"),
    })
    .strict();
}

export type ProjectionCodec<P> = Readonly<{
  serialize(value: P): Result<string>;
  deserialize(value: string): Result<P>;
}>;

function codecError(): Result<never> {
  return {
    ok: false,
    error: {
      code: "PROJECTION_INVALID",
      message: "Connector projection is invalid.",
      retry: "NEVER",
    },
  };
}

export function createProjectionCodec<P>(schema: z.ZodType<P>): ProjectionCodec<P> {
  return {
    serialize(value) {
      const parsed = schema.safeParse(value);
      if (!parsed.success) return codecError();
      try {
        const serialized = JSON.stringify(parsed.data);
        return Buffer.byteLength(serialized, "utf8") <= 65_536
          ? { ok: true, value: serialized }
          : codecError();
      } catch {
        return codecError();
      }
    },
    deserialize(value) {
      if (value.length < 1 || Buffer.byteLength(value, "utf8") > 65_536) return codecError();
      try {
        const parsed = schema.safeParse(JSON.parse(value));
        return parsed.success ? { ok: true, value: parsed.data } : codecError();
      } catch {
        return codecError();
      }
    },
  };
}

const ObservationProvenanceSchema = z
  .object({
    projectId: IdentifierSchema,
    connectorId: IdentifierSchema,
    connectorEpoch: RevisionSchema.refine((value) => value > 0),
    kind: z.enum(["WEBHOOK", "RECONCILIATION", "MUTATION_CONFIRMATION"]),
    providerActorId: z.string().min(1).max(256).optional(),
  })
  .strict();

export function ObservedSchema<T extends z.ZodType>(valueSchema: T) {
  return z
    .object({
      value: valueSchema,
      reference: BoundedReferenceSchema,
      sourceRevision: BoundedRevisionSchema,
      comparableDigest: Sha256Schema,
      projectionRevision: RevisionSchema,
      observedAt: InstantSchema,
      sourceUpdatedAt: InstantSchema.optional(),
      freshness: z.enum(["FRESH", "STALE", "UNAVAILABLE", "REDACTED"]),
      provenance: ObservationProvenanceSchema,
      consistency: z.enum(["ATOMIC", "RESIDUAL_RACE"]).optional(),
    })
    .strict();
}

export type ExactRevisionMutation<T> = Readonly<{
  projectId: ProjectId;
  connectorId: ConnectorId;
  connectorEpoch: number;
  idempotencyKey: string;
  precondition:
    | Readonly<{ kind: "ABSENT" }>
    | Readonly<{ kind: "EXACT_REVISION"; sourceRevision: string; comparableDigest: Sha256 }>
    | Readonly<{
        kind: "EXPECTED_MEMBERSHIP";
        sourceRevision: string;
        comparableDigest: Sha256;
        memberKey: string;
        present: boolean;
      }>;
  actionDigest: Sha256;
  mutation: T;
}>;

export function ExactRevisionMutationSchema<T extends z.ZodType>(mutationSchema: T) {
  return z
    .object({
      projectId: IdentifierSchema,
      connectorId: IdentifierSchema,
      connectorEpoch: RevisionSchema.refine((value) => value > 0),
      idempotencyKey: IdentifierSchema,
      precondition: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("ABSENT") }).strict(),
        z
          .object({
            kind: z.literal("EXACT_REVISION"),
            sourceRevision: BoundedRevisionSchema,
            comparableDigest: Sha256Schema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("EXPECTED_MEMBERSHIP"),
            sourceRevision: BoundedRevisionSchema,
            comparableDigest: Sha256Schema,
            memberKey: BoundedReferenceSchema,
            present: z.boolean(),
          })
          .strict(),
      ]),
      actionDigest: Sha256Schema,
      mutation: mutationSchema,
    })
    .strict();
}

export type ReconciliationCursor = string;

export type ReconciliationEvent<P> = Readonly<{
  projectId: ProjectId;
  connectorId: ConnectorId;
  connectorEpoch: number;
  idempotencyKey: string;
  reference: ContextReference;
  actionMarker?: string;
  mutationProof?: Readonly<{
    actionMarker: string;
    operation: string;
    actionDigest: Sha256;
    precondition:
      | Readonly<{ kind: "ABSENT" }>
      | Readonly<{ kind: "EXACT_REVISION"; sourceRevision: string; comparableDigest: Sha256 }>
      | Readonly<{
          kind: "EXPECTED_MEMBERSHIP";
          sourceRevision: string;
          comparableDigest: Sha256;
          memberKey: string;
          present: boolean;
        }>;
  }>;
  sourceRevision: string;
  comparableDigest: Sha256;
  observedAt: number;
  sourceUpdatedAt?: number;
  freshness: "FRESH" | "STALE" | "UNAVAILABLE" | "REDACTED";
  provenance: Readonly<{
    kind: "WEBHOOK" | "RECONCILIATION" | "MUTATION_CONFIRMATION";
    providerActorId?: string;
  }>;
  value: P;
}>;

export type ConnectorOperationAuthorization = Readonly<{
  kind: "CONNECTOR_OPERATION";
  id: string;
  proof: string;
  projectId: ProjectId;
  connectorId: ConnectorId;
  connectorEpoch: number;
  reference: ContextReference;
  operation: string;
  actionDigest: Sha256;
  expiresAt: number;
}>;

export interface SourceConnector<R, P, M> {
  inspect(scope: ConnectorScope, reference: R): Promise<Result<Observed<P>>>;
  mutate(
    authorization: ConnectorOperationAuthorization,
    command: ExactRevisionMutation<M>,
  ): Promise<Result<Observed<P>>>;
  scan(
    scope: ConnectorScope,
    cursor?: ReconciliationCursor,
  ): AsyncIterable<Result<ReconciliationEvent<P>>>;
}

export type ScopedSearch = Readonly<{
  query: string;
  providerLimit: number;
  resultLimit: number;
  maximumTotalSnippetBytes: number;
  timeoutMs: number;
}>;

export const ScopedSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(512),
    providerLimit: z.number().int().min(1).max(16),
    resultLimit: z.number().int().min(1).max(100),
    maximumTotalSnippetBytes: z
      .number()
      .int()
      .min(1)
      .max(256 * 1024),
    timeoutMs: z.number().int().min(1).max(30_000),
  })
  .strict();

export type EphemeralSearchResult<R> = Readonly<{
  reference: R;
  title: string;
  snippet: string;
  sourceUpdatedAt?: number;
  persistence: "EPHEMERAL_ONLY";
}>;

export type EphemeralSearchPage<R> = Readonly<{
  results: readonly EphemeralSearchResult<R>[];
  partialFailureCount: number;
  truncated: boolean;
  persistence: "EPHEMERAL_ONLY";
}>;

export function EphemeralSearchResultSchema<R extends z.ZodType>(referenceSchema: R) {
  return z
    .object({
      reference: referenceSchema,
      title: z.string().min(1).max(256),
      snippet: z.string().max(2_048),
      sourceUpdatedAt: InstantSchema.optional(),
      persistence: z.literal("EPHEMERAL_ONLY"),
    })
    .strict();
}

export function EphemeralSearchPageSchema<R extends z.ZodType>(referenceSchema: R) {
  return z
    .object({
      results: z.array(EphemeralSearchResultSchema(referenceSchema)).max(100),
      partialFailureCount: z.number().int().min(0).max(16),
      truncated: z.boolean(),
      persistence: z.literal("EPHEMERAL_ONLY"),
    })
    .strict()
    .refine(
      (page) =>
        page.results.reduce(
          (bytes, result) => bytes + Buffer.byteLength(result.snippet, "utf8"),
          0,
        ) <=
        256 * 1024,
      "Search snippets exceed the aggregate byte limit",
    );
}

export interface ContextConnector<R, LiveRead, Projection, M> {
  search(scope: ConnectorScope, query: ScopedSearch): Promise<Result<EphemeralSearchPage<R>>>;
  read(scope: ConnectorScope, reference: R): Promise<Result<EphemeralObserved<LiveRead>>>;
  mutate(
    authorization: ConnectorOperationAuthorization,
    command: ExactRevisionMutation<M>,
  ): Promise<Result<Observed<Projection>>>;
}
