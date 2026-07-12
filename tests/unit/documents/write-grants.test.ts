import { expect, test } from "bun:test";
import { authorizeDocumentGrant } from "../../../src/server/modules/documents/write-grants.ts";
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
      sourceRevision: "7",
      comparableDigest: "a".repeat(64) as never,
      documentRevision: 1,
    },
  ],
  operations: ["EDIT_CONTENT" as const],
  createdAt: 0,
  expiresAt: 100,
};
test.each([
  ["another run", { runId: "run_b" }, "DOCUMENT_GRANT_RUN_MISMATCH"],
  ["another document", { documentId: "doc_b" }, "DOCUMENT_GRANT_SCOPE_DENIED"],
  ["expired", { now: 100 }, "DOCUMENT_GRANT_EXPIRED"],
  ["epoch moved", { connectorEpoch: 2 }, "CONNECTOR_REVOKED"],
] as const)("rejects %s", (_name, override, code) => {
  const result = authorizeDocumentGrant(grant, {
    runId: "run_a",
    documentId: "doc_a",
    connectorEpoch: 1,
    grantRevision: 1,
    sourceRevision: "7",
    comparableDigest: "a".repeat(64),
    now: 50,
    ...override,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
});
test("allows repeated exact edits only after advancing the cursor", () => {
  expect(
    authorizeDocumentGrant(grant, {
      runId: "run_a",
      documentId: "doc_a",
      connectorEpoch: 1,
      grantRevision: 1,
      sourceRevision: "7",
      comparableDigest: "a".repeat(64),
      now: 50,
    }).ok,
  ).toBe(true);
});
test("denies a grant whose persisted operation set does not include the requested edit", () => {
  const result = authorizeDocumentGrant(
    { ...grant, operations: [] },
    {
      runId: "run_a",
      documentId: "doc_a",
      connectorEpoch: 1,
      grantRevision: 1,
      sourceRevision: "7",
      comparableDigest: "a".repeat(64),
      now: 50,
    },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("DOCUMENT_GRANT_OPERATION_DENIED");
});
