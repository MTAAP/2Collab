import { createHash } from "node:crypto";
import { z } from "zod";
import { IdentifierSchema, InstantSchema, Sha256Schema } from "./ids.ts";
import type { Result } from "./result.ts";

const bounded = (maximum: number) => z.string().min(1).max(maximum);

export const OutlineReferenceSchema = z
  .object({
    kind: z.literal("OUTLINE_DOCUMENT"),
    workspaceId: IdentifierSchema,
    documentId: IdentifierSchema,
  })
  .strict();
export type OutlineReference = Readonly<z.infer<typeof OutlineReferenceSchema>>;

export const AuthoredDocumentPatchSchema = z
  .object({
    format: z.literal("UNIFIED_TEXT_PATCH_V1"),
    value: z.string().min(1),
    digest: Sha256Schema,
  })
  .strict();
export type AuthoredDocumentPatch = Readonly<z.infer<typeof AuthoredDocumentPatchSchema>>;

export const BotDocumentOperationProvenanceSchema = z
  .object({
    runId: IdentifierSchema,
    attemptId: IdentifierSchema,
    grantId: IdentifierSchema,
    grantRevision: z.number().int().positive(),
    grantorMemberId: IdentifierSchema,
    connectorEpoch: z.number().int().positive(),
    editedSourceRevision: bounded(128),
  })
  .strict();
export type BotDocumentOperationProvenance = Readonly<
  z.infer<typeof BotDocumentOperationProvenanceSchema>
>;

export const OutlineMutationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("CREATE_DOCUMENT_AS_MEMBER"),
      collectionId: IdentifierSchema,
      title: bounded(240),
      body: z.string().max(1_048_576),
    })
    .strict(),
  z
    .object({
      kind: z.literal("EDIT_DOCUMENT_AS_MEMBER"),
      documentId: IdentifierSchema,
      authoredPatch: AuthoredDocumentPatchSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("EDIT_DOCUMENT_AS_BOT"),
      provenance: BotDocumentOperationProvenanceSchema,
      documentId: IdentifierSchema,
      authoredPatch: AuthoredDocumentPatchSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("APPLY_PROPOSAL_AS_MEMBER"),
      proposalId: IdentifierSchema,
      documentId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("PROMOTE_WORKING_DOCUMENT"),
      workingDocumentId: IdentifierSchema,
      targetCollectionId: IdentifierSchema,
      title: bounded(240),
    })
    .strict(),
  z
    .object({ kind: z.literal("ARCHIVE_WORKING_DOCUMENT"), workingDocumentId: IdentifierSchema })
    .strict(),
]);
export type OutlineMutation = Readonly<z.infer<typeof OutlineMutationSchema>>;

export const OutlineDocumentProjectionSchema = z
  .object({
    workspaceId: IdentifierSchema,
    documentId: IdentifierSchema,
    collectionId: IdentifierSchema,
    title: bounded(240),
    sourceRevision: bounded(128),
    comparableDigest: Sha256Schema,
    sourceUpdatedAt: InstantSchema.optional(),
    archived: z.boolean(),
    providerActorId: bounded(128).optional(),
  })
  .strict();
export type OutlineDocumentProjection = Readonly<z.infer<typeof OutlineDocumentProjectionSchema>>;

export const OutlineReadResultSchema = OutlineDocumentProjectionSchema.extend({
  body: z.string().max(1_048_576),
}).strict();
export type OutlineReadResult = Readonly<z.infer<typeof OutlineReadResultSchema>>;

export const OutlineProviderIdentitySchema = z
  .object({ workspaceId: IdentifierSchema, userId: IdentifierSchema, displayName: bounded(160) })
  .strict();
export type OutlineProviderIdentity = Readonly<z.infer<typeof OutlineProviderIdentitySchema>>;

export type CanonicalOutlineOrigin = string;
export type VerifiedOutlineOAuthMetadata = Readonly<{
  origin: CanonicalOutlineOrigin;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  supportsPkceS256: true;
  digest: string;
}>;
export type VerifiedOutlineOAuthTransaction = Readonly<{
  connectorId: string;
  memberId: string;
  sessionId: string;
  redirectOriginDigest: string;
  pkceVerifier: string;
  requestedScopeDigest: string;
}>;
export type ProviderTokenSet = Readonly<{
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  grantedScope: readonly string[];
}>;
export type EncryptedOutlineOAuthGrant = Readonly<{
  connectorId: string;
  memberId: string;
  credentialId: string;
  revision: number;
}>;
export type ProviderRevocationResult = Readonly<{ revoked: boolean }>;
export type EphemeralProviderAccess = Readonly<{ accessToken: string }>;

function invalidPatch(): Result<never> {
  return {
    ok: false,
    error: { code: "OUTLINE_PATCH_INVALID", message: "Document patch is invalid.", retry: "NEVER" },
  };
}

function containsForbiddenControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

export async function validateAuthoredDocumentPatch(
  input: unknown,
): Promise<Result<AuthoredDocumentPatch>> {
  const parsed = AuthoredDocumentPatchSchema.safeParse(input);
  if (!parsed.success) return invalidPatch();
  const bytes = new TextEncoder().encode(parsed.data.value);
  if (
    bytes.byteLength > 131_072 ||
    containsForbiddenControl(parsed.data.value) ||
    !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?:\n[ +-].*)+$/u.test(parsed.data.value) ||
    !parsed.data.value.split("\n").some((line) => line.startsWith("+") || line.startsWith("-")) ||
    createHash("sha256").update(bytes).digest("hex") !== parsed.data.digest
  ) {
    return invalidPatch();
  }
  return { ok: true, value: parsed.data };
}
