import { z } from "zod";
import type { ConnectorId, CoordinationRecordId, ProjectId } from "./ids.ts";
import { IdentifierSchema, RevisionSchema, Sha256Schema } from "./ids.ts";

export type SourceRef = Readonly<{
  kind: "GITHUB_ISSUE" | "GITHUB_PULL_REQUEST" | "OUTLINE_DOCUMENT";
  connectorId: ConnectorId;
  sourceItemId: string;
  observedRevision: string;
}>;

export type ContextReference = Readonly<{
  kind: "COORDINATION_RECORD" | "SOURCE" | "PUBLISHED_GIT_REFERENCE";
  projectId: ProjectId;
  referenceId: string;
  observedRevision?: string;
}>;

export type CoordinationSelection =
  | Readonly<{ kind: "NEW"; title: string; sourceRefs: readonly SourceRef[] }>
  | Readonly<{
      kind: "EXISTING";
      coordinationRecordId: CoordinationRecordId;
      expectedRevision: number;
    }>;

export const SourceRefSchema = z
  .object({
    kind: z.enum(["GITHUB_ISSUE", "GITHUB_PULL_REQUEST", "OUTLINE_DOCUMENT"]),
    connectorId: IdentifierSchema,
    sourceItemId: z.string().min(1).max(256),
    observedRevision: z.string().min(1).max(128),
  })
  .strict();

export const CoordinationSelectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("NEW"),
      title: z.string().min(1).max(160),
      sourceRefs: z.array(SourceRefSchema).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("EXISTING"),
      coordinationRecordId: IdentifierSchema,
      expectedRevision: RevisionSchema,
    })
    .strict(),
]);

export const BootstrapContextReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("COORDINATION_RECORD"),
      referenceId: IdentifierSchema,
      revision: RevisionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("SOURCE_PROJECTION"),
      connectorId: IdentifierSchema,
      referenceId: z.string().min(1).max(256),
      observedRevision: z.string().min(1).max(128),
      projectionDigest: Sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("PUBLISHED_GIT_REFERENCE"),
      remoteIdentity: IdentifierSchema,
      referenceId: z.string().min(1).max(512),
      commitSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    })
    .strict(),
]);

export const BootstrapEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    contextRecipe: z
      .object({
        id: IdentifierSchema,
        version: z.number().int().positive(),
        digest: Sha256Schema,
      })
      .strict(),
    references: z.array(BootstrapContextReferenceSchema).max(64),
  })
  .strict();

export type BootstrapEnvelope = Readonly<z.infer<typeof BootstrapEnvelopeSchema>>;

export type ContextCategory =
  | "COORDINATION"
  | "SOURCE"
  | "REPOSITORY"
  | "PUBLISHED_GIT_REFERENCE"
  | "INSTRUCTION"
  | "CHECKPOINT"
  | "EVIDENCE"
  | "GATE";

export type ContextReferenceStatus = "FRESH" | "STALE";
export type ContextOmissionReason =
  | "FORBIDDEN"
  | "UNAVAILABLE"
  | "DUPLICATE"
  | "CATEGORY_LIMIT"
  | "TOTAL_LIMIT";

const ContextCategorySchema = z.enum([
  "COORDINATION",
  "SOURCE",
  "REPOSITORY",
  "PUBLISHED_GIT_REFERENCE",
  "INSTRUCTION",
  "CHECKPOINT",
  "EVIDENCE",
  "GATE",
]);

const ReferenceFirstContextReferenceSchema = z
  .object({
    category: ContextCategorySchema,
    referenceId: z.string().min(1).max(256),
    observedRevision: z.string().min(1).max(128),
    status: z.enum(["FRESH", "STALE"]),
    authoredPreview: z
      .string()
      .refine((value) => new TextEncoder().encode(value).byteLength <= 65_536)
      .optional(),
  })
  .strict();

const ReferenceFirstContextOmissionSchema = z
  .object({
    category: ContextCategorySchema,
    referenceId: z.string().min(1).max(256),
    reason: z.enum(["FORBIDDEN", "UNAVAILABLE", "DUPLICATE", "CATEGORY_LIMIT", "TOTAL_LIMIT"]),
  })
  .strict();

export const ReferenceFirstBootstrapEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    contextRecipe: z
      .object({
        id: IdentifierSchema,
        version: z.number().int().positive(),
        digest: Sha256Schema,
      })
      .strict(),
    references: z.array(ReferenceFirstContextReferenceSchema).max(64),
    omissions: z.array(ReferenceFirstContextOmissionSchema).max(4_096),
  })
  .strict()
  .refine(
    (envelope) =>
      envelope.references.reduce(
        (bytes, reference) =>
          bytes +
          (reference.authoredPreview === undefined
            ? 0
            : new TextEncoder().encode(reference.authoredPreview).byteLength),
        0,
      ) <= 65_536,
    "Authored previews exceed the bootstrap envelope byte limit",
  )
  .refine((envelope) => {
    const keys = envelope.references.map(
      (reference) => `${reference.category}\u0000${reference.referenceId}`,
    );
    return new Set(keys).size === keys.length;
  }, "Bootstrap references must be unique");

export type ReferenceFirstBootstrapEnvelope = Readonly<
  z.infer<typeof ReferenceFirstBootstrapEnvelopeSchema>
>;
