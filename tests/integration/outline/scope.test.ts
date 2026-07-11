import { expect, test } from "bun:test";
import { StrictOutlineContentAdapter } from "../../fixtures/outline/strict-outline-adapter.ts";

const scope = {
  projectId: "project_1" as never,
  connectorId: "connector_1" as never,
  connectorEpoch: 1,
  references: ["OUTLINE_COLLECTION:allowed"],
  operations: ["READ"],
};

test("re-resolves native collection and denies moved or out-of-scope documents", async () => {
  const outline = StrictOutlineContentAdapter.seed({
    documents: [
      { id: "doc_a", collectionId: "allowed", title: "Allowed", body: "body" },
      { id: "doc_denied", collectionId: "denied", title: "Denied", body: "secret" },
    ],
  });
  const denied = await outline.read(scope, {
    kind: "OUTLINE_DOCUMENT",
    workspaceId: "workspace_1" as never,
    documentId: "doc_denied" as never,
  });
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.error.code).toBe("OUTLINE_SCOPE_DENIED");
  outline.moveExternally("doc_a", "denied");
  expect(
    (
      await outline.read(scope, {
        kind: "OUTLINE_DOCUMENT",
        workspaceId: "workspace_1" as never,
        documentId: "doc_a" as never,
      })
    ).ok,
  ).toBe(false);
});
