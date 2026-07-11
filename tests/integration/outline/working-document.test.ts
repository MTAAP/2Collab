import { expect, test } from "bun:test";
import { disposition } from "../../../src/server/modules/documents/working-documents.ts";
const document = {
  workingDocumentId: "working",
  runId: "run",
  documentId: "doc",
  lifecycleRevision: 1,
  classification: "WORKING_MATERIAL" as const,
  approvalId: "approval",
};
test("keep remains non-authoritative and promote/archive need member authority", () => {
  expect(
    disposition({ document, expectedLifecycleRevision: 1, kind: "KEEP", memberAuthorized: false }),
  ).toEqual({
    ok: true,
    value: { kind: "KEEP", nextLifecycleRevision: 2, classification: "WORKING_MATERIAL" },
  });
  const denied = disposition({
    document,
    expectedLifecycleRevision: 1,
    kind: "PROMOTE",
    memberAuthorized: false,
  });
  expect(denied.ok).toBe(false);
});
