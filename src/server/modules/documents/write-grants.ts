import type { DocumentWriteGrant } from "../../../shared/contracts/document-grants.ts";
import type { Result } from "../../../shared/contracts/result.ts";

export type GrantAuthorization = Readonly<{
  runId: string;
  documentId: string;
  connectorEpoch: number;
  grantRevision: number;
  sourceRevision: string;
  comparableDigest: string;
  now: number;
}>;
const denied = (code: string, retry: "NEVER" | "REFRESH" = "NEVER"): Result<never> => ({
  ok: false,
  error: { code, message: "Document write authority is denied.", retry },
});

export function authorizeDocumentGrant(
  grant: DocumentWriteGrant,
  input: GrantAuthorization,
): Result<Readonly<{ operation: "EDIT_CONTENT" }>> {
  if (grant.revokedAt !== undefined) return denied("DOCUMENT_GRANT_REVOKED");
  if (grant.runId !== input.runId) return denied("DOCUMENT_GRANT_RUN_MISMATCH");
  if (grant.connectorEpoch !== input.connectorEpoch) return denied("CONNECTOR_REVOKED", "REFRESH");
  if (grant.grantRevision !== input.grantRevision)
    return denied("DOCUMENT_GRANT_REVISION_STALE", "REFRESH");
  if (input.now >= grant.expiresAt) return denied("DOCUMENT_GRANT_EXPIRED");
  if (!grant.operations.includes("EDIT_CONTENT")) return denied("DOCUMENT_GRANT_OPERATION_DENIED");
  const document = grant.documents.find((candidate) => candidate.documentId === input.documentId);
  if (!document) return denied("DOCUMENT_GRANT_SCOPE_DENIED");
  if (
    document.sourceRevision !== input.sourceRevision ||
    document.comparableDigest !== input.comparableDigest
  )
    return denied("SOURCE_REVISION_STALE", "REFRESH");
  return { ok: true, value: { operation: "EDIT_CONTENT" } };
}

export function advanceGrantDocument(
  grant: DocumentWriteGrant,
  input: Readonly<{ documentId: string; sourceRevision: string; comparableDigest: string }>,
): Result<DocumentWriteGrant> {
  if (!grant.documents.some((item) => item.documentId === input.documentId))
    return denied("DOCUMENT_GRANT_SCOPE_DENIED");
  return {
    ok: true,
    value: {
      ...grant,
      grantRevision: grant.grantRevision + 1,
      documents: grant.documents.map((item) =>
        item.documentId === input.documentId
          ? {
              ...item,
              sourceRevision: input.sourceRevision,
              comparableDigest: input.comparableDigest as never,
              documentRevision: item.documentRevision + 1,
            }
          : item,
      ),
    },
  };
}
