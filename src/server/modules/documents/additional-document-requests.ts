import type {
  AdditionalDocumentRequest,
  DocumentWriteGrant,
} from "../../../shared/contracts/document-grants.ts";
import type { Result } from "../../../shared/contracts/result.ts";
export function requestAdditionalDocument(
  input: Readonly<{
    requestId: string;
    grant: DocumentWriteGrant;
    documentId: string;
    runId: string;
    now: number;
  }>,
): Result<AdditionalDocumentRequest> {
  if (input.runId !== input.grant.runId)
    return {
      ok: false,
      error: {
        code: "DOCUMENT_GRANT_RUN_MISMATCH",
        message: "Document request is denied.",
        retry: "NEVER",
      },
    };
  return {
    ok: true,
    value: {
      requestId: input.requestId as never,
      grantId: input.grant.grantId,
      documentId: input.documentId as never,
      requestedByRunId: input.runId as never,
      status: "PENDING",
      requestRevision: 1,
      createdAt: input.now,
    },
  };
}
export function decideAdditionalDocumentRequest(
  input: Readonly<{
    request: AdditionalDocumentRequest;
    grant: DocumentWriteGrant;
    memberId: string;
    decision: "APPROVED" | "REJECTED";
    sourceRevision: string;
    comparableDigest: string;
    now: number;
  }>,
): Result<Readonly<{ request: AdditionalDocumentRequest; grant: DocumentWriteGrant }>> {
  if (input.request.status !== "PENDING")
    return {
      ok: false,
      error: {
        code: "DOCUMENT_REQUEST_DECIDED",
        message: "Document request was already decided.",
        retry: "NEVER",
      },
    };
  const request = {
    ...input.request,
    status: input.decision,
    requestRevision: input.request.requestRevision + 1,
    decidedByMemberId: input.memberId as never,
    decidedAt: input.now,
  } as const;
  const grant =
    input.decision === "APPROVED"
      ? {
          ...input.grant,
          grantRevision: input.grant.grantRevision + 1,
          documents: [
            ...input.grant.documents,
            {
              documentId: input.request.documentId,
              sourceRevision: input.sourceRevision,
              comparableDigest: input.comparableDigest as never,
              documentRevision: 1,
            },
          ],
        }
      : input.grant;
  return { ok: true, value: { request, grant } };
}
