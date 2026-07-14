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

type UnifiedPatchHunk = Readonly<{
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: readonly string[];
}>;

function patchLineIndex(start: number, count: number): number {
  return count === 0 ? start : start - 1;
}

function parseUnifiedTextPatch(value: string): readonly UnifiedPatchHunk[] | null {
  const lines = value.split("\n");
  const hunks: UnifiedPatchHunk[] = [];
  let changed = false;
  let index = 0;
  let previousOldEnd = 0;
  let previousNewEnd = 0;
  while (index < lines.length) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/u.exec(lines[index] ?? "");
    if (!match) return null;
    const oldStart = Number(match[1]);
    const oldCount = Number(match[2] ?? 1);
    const newStart = Number(match[3]);
    const newCount = Number(match[4] ?? 1);
    if (
      !Number.isSafeInteger(oldStart) ||
      !Number.isSafeInteger(oldCount) ||
      !Number.isSafeInteger(newStart) ||
      !Number.isSafeInteger(newCount) ||
      oldCount < 0 ||
      newCount < 0 ||
      (oldStart === 0 && oldCount !== 0) ||
      (newStart === 0 && newCount !== 0)
    )
      return null;
    index += 1;
    const hunkLines: string[] = [];
    while (index < lines.length && !lines[index]?.startsWith("@@ ")) {
      const line = lines[index] ?? "";
      if (!/^[ +-]/u.test(line)) return null;
      hunkLines.push(line);
      changed ||= line[0] === "+" || line[0] === "-";
      index += 1;
    }
    if (!hunkLines.length) return null;
    const consumedOld = hunkLines.filter((line) => line[0] !== "+").length;
    const producedNew = hunkLines.filter((line) => line[0] !== "-").length;
    const oldIndex = patchLineIndex(oldStart, oldCount);
    const newIndex = patchLineIndex(newStart, newCount);
    if (
      consumedOld !== oldCount ||
      producedNew !== newCount ||
      oldIndex < previousOldEnd ||
      newIndex < previousNewEnd
    )
      return null;
    previousOldEnd = oldIndex + oldCount;
    previousNewEnd = newIndex + newCount;
    hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
  }
  return changed && hunks.length ? hunks : null;
}

export type PreparedOutlinePatch = Readonly<{
  body: string;
  editMode: "patch" | "replace";
  text: string;
  findText?: string;
}>;

export function prepareAuthoredDocumentPatch(
  body: string,
  patch: string,
): Result<PreparedOutlinePatch> {
  const hunks = parseUnifiedTextPatch(patch);
  if (!hunks) return invalidPatch();
  const source = body === "" ? [] : body.split("\n");
  const output: string[] = [];
  let sourceIndex = 0;
  let oldStart = Number.POSITIVE_INFINITY;
  let oldEnd = 0;
  let newStart = Number.POSITIVE_INFINITY;
  let newEnd = 0;
  for (const hunk of hunks) {
    const hunkOldIndex = patchLineIndex(hunk.oldStart, hunk.oldCount);
    const hunkNewIndex = patchLineIndex(hunk.newStart, hunk.newCount);
    if (hunkOldIndex < sourceIndex || hunkOldIndex > source.length) return invalidPatch();
    output.push(...source.slice(sourceIndex, hunkOldIndex));
    if (output.length !== hunkNewIndex) return invalidPatch();
    let cursor = hunkOldIndex;
    for (const line of hunk.lines) {
      const marker = line[0];
      const value = line.slice(1);
      if (marker !== "+") {
        if (source[cursor] !== value) return invalidPatch();
        cursor += 1;
      }
      if (marker !== "-") output.push(value);
    }
    sourceIndex = cursor;
    oldStart = Math.min(oldStart, hunkOldIndex);
    oldEnd = Math.max(oldEnd, hunkOldIndex + hunk.oldCount);
    newStart = Math.min(newStart, hunkNewIndex);
    newEnd = Math.max(newEnd, hunkNewIndex + hunk.newCount);
  }
  output.push(...source.slice(sourceIndex));
  const nextBody = output.join("\n");
  if (!source.length)
    return { ok: true, value: { body: nextBody, editMode: "replace", text: nextBody } };

  while (true) {
    const findText = source.slice(oldStart, oldEnd).join("\n");
    if (findText && body.indexOf(findText) === body.lastIndexOf(findText)) {
      return {
        ok: true,
        value: {
          body: nextBody,
          editMode: "patch",
          findText,
          text: output.slice(newStart, newEnd).join("\n"),
        },
      };
    }
    if (oldStart > 0 && newStart > 0) {
      oldStart -= 1;
      newStart -= 1;
    } else if (oldEnd < source.length && newEnd < output.length) {
      oldEnd += 1;
      newEnd += 1;
    } else {
      return {
        ok: true,
        value: { body: nextBody, editMode: "patch", findText: body, text: nextBody },
      };
    }
  }
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
    !parseUnifiedTextPatch(parsed.data.value) ||
    createHash("sha256").update(bytes).digest("hex") !== parsed.data.digest
  ) {
    return invalidPatch();
  }
  return { ok: true, value: parsed.data };
}
