import { z } from "zod";
import { AuthoredDocumentPatchSchema } from "./outline.ts";
import { IdentifierSchema, Sha256Schema } from "./ids.ts";
export const DocumentProposalSchema = z
  .object({
    proposalId: IdentifierSchema,
    projectId: IdentifierSchema,
    connectorId: IdentifierSchema,
    connectorEpoch: z.number().int().positive(),
    documentId: IdentifierSchema,
    runId: IdentifierSchema,
    attemptId: IdentifierSchema,
    baseRevision: z.string().min(1).max(256),
    baseDigest: Sha256Schema,
    authoredPatch: AuthoredDocumentPatchSchema,
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type DocumentProposal = Readonly<z.infer<typeof DocumentProposalSchema>>;
export const DocumentConflictSchema = z
  .object({
    conflictId: IdentifierSchema,
    proposalId: IdentifierSchema,
    currentRevision: z.string().min(1).max(256),
    currentDigest: Sha256Schema,
    detectedAt: z.number().int().nonnegative(),
  })
  .strict();
export type DocumentConflict = Readonly<z.infer<typeof DocumentConflictSchema>>;
export const WorkingDocumentDispositionSchema = z.enum(["KEEP", "PROMOTE", "ARCHIVE"]);
