import type { Result } from "../../../shared/contracts/result.ts";
export type WorkingDocument = Readonly<{
  workingDocumentId: string;
  runId: string;
  documentId: string;
  lifecycleRevision: number;
  classification: "WORKING_MATERIAL";
  approvalId: string;
}>;
export function disposition(
  input: Readonly<{
    document: WorkingDocument;
    expectedLifecycleRevision: number;
    kind: "KEEP" | "PROMOTE" | "ARCHIVE";
    memberAuthorized: boolean;
  }>,
): Result<
  Readonly<{
    kind: "KEEP" | "PROMOTE" | "ARCHIVE";
    nextLifecycleRevision: number;
    classification: "WORKING_MATERIAL" | "DURABLE_KNOWLEDGE" | "ARCHIVED";
  }>
> {
  if (input.expectedLifecycleRevision !== input.document.lifecycleRevision)
    return {
      ok: false,
      error: {
        code: "WORKING_DOCUMENT_STALE",
        message: "Working document changed.",
        retry: "REFRESH",
      },
    };
  if (input.kind !== "KEEP" && !input.memberAuthorized)
    return {
      ok: false,
      error: {
        code: "MEMBER_AUTHORIZATION_REQUIRED",
        message: "Member authorization is required.",
        retry: "EXPLICIT_RESUME",
      },
    };
  return {
    ok: true,
    value: {
      kind: input.kind,
      nextLifecycleRevision: input.document.lifecycleRevision + 1,
      classification:
        input.kind === "KEEP"
          ? "WORKING_MATERIAL"
          : input.kind === "PROMOTE"
            ? "DURABLE_KNOWLEDGE"
            : "ARCHIVED",
    },
  };
}
