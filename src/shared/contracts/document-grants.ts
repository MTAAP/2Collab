import { z } from "zod";
import { IdentifierSchema, Sha256Schema } from "./ids.ts";

export const DocumentGrantOperationSchema = z.literal("EDIT_CONTENT");
export const DocumentWriteGrantSchema = z
  .object({
    grantId: IdentifierSchema,
    projectId: IdentifierSchema,
    connectorId: IdentifierSchema,
    runId: IdentifierSchema,
    grantorMemberId: IdentifierSchema,
    connectorEpoch: z.number().int().positive(),
    grantRevision: z.number().int().positive(),
    documents: z
      .array(
        z
          .object({
            documentId: IdentifierSchema,
            sourceRevision: z.string().min(1).max(256),
            comparableDigest: Sha256Schema,
            documentRevision: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    operations: z.array(DocumentGrantOperationSchema).length(1),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    revokedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export type DocumentWriteGrant = Readonly<z.infer<typeof DocumentWriteGrantSchema>>;

export const AdditionalDocumentRequestSchema = z
  .object({
    requestId: IdentifierSchema,
    grantId: IdentifierSchema,
    documentId: IdentifierSchema,
    requestedByRunId: IdentifierSchema,
    status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
    requestRevision: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    decidedByMemberId: IdentifierSchema.optional(),
    decidedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export type AdditionalDocumentRequest = Readonly<z.infer<typeof AdditionalDocumentRequestSchema>>;
