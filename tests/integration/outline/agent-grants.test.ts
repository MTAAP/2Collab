import { expect, test } from "bun:test";
import {
  decideAdditionalDocumentRequest,
  requestAdditionalDocument,
} from "../../../src/server/modules/documents/additional-document-requests.ts";
test("requests confer no authority until an explicit member approval extends the exact grant", () => {
  const grant = {
    grantId: "grant_a" as never,
    projectId: "project_a" as never,
    connectorId: "connector_a" as never,
    runId: "run_a" as never,
    grantorMemberId: "member_a" as never,
    connectorEpoch: 1,
    grantRevision: 1,
    documents: [
      {
        documentId: "doc_a" as never,
        sourceRevision: "1",
        comparableDigest: "a".repeat(64) as never,
        documentRevision: 1,
      },
    ],
    operations: ["EDIT_CONTENT" as const],
    createdAt: 0,
    expiresAt: 100,
  };
  const pending = requestAdditionalDocument({
    requestId: "request_a",
    grant,
    documentId: "doc_b",
    runId: "run_a",
    now: 1,
  });
  expect(pending.ok).toBe(true);
  expect(JSON.stringify(grant.documents.map((item) => item.documentId))).toBe('["doc_a"]');
  if (!pending.ok) return;
  const approved = decideAdditionalDocumentRequest({
    request: pending.value,
    grant,
    memberId: "member_b",
    decision: "APPROVED",
    sourceRevision: "3",
    comparableDigest: "b".repeat(64),
    now: 2,
  });
  expect(approved.ok).toBe(true);
  if (approved.ok)
    expect(approved.value.grant.documents.map((item) => item.documentId)).toEqual([
      "doc_a",
      "doc_b",
    ]);
});
