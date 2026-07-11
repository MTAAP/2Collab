import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { createHumanDocumentEditing } from "../../../src/server/modules/documents/human-editing.ts";
import { StrictOutlineContentAdapter } from "../../fixtures/outline/strict-outline-adapter.ts";
import { authority, hash, scope } from "./human-editing.test.ts";

const authoredPatch = (from: string, to: string) => {
  const value = `@@ -1,1 +1,1 @@\n-${from}\n+${to}`;
  return {
    format: "UNIFIED_TEXT_PATCH_V1" as const,
    value,
    digest: createHash("sha256").update(value).digest("hex") as never,
  };
};

test("stale member save preserves the authored patch digest and current reference", async () => {
  const outline = StrictOutlineContentAdapter.seed({
    documents: [{ id: "doc_a", collectionId: "allowed", title: "A", body: "zero" }],
  });
  const editing = createHumanDocumentEditing({
    outline,
    authority,
    async requireDelegatedMember(memberId) {
      return { ok: true, value: { outlineUserId: memberId } };
    },
  });
  const base = await outline.read(scope, {
    kind: "OUTLINE_DOCUMENT",
    workspaceId: "workspace_1" as never,
    documentId: "doc_a" as never,
  });
  if (!base.ok) throw new Error("fixture read failed");
  const firstPatch = authoredPatch("zero", "first");
  const first = await editing.editDocumentAsMember({
    memberId: "member_a",
    projectId: "project_1",
    connectorId: "connector_1",
    connectorEpoch: 1,
    workspaceId: "workspace_1",
    idempotencyKey: "edit_1",
    documentId: "doc_a",
    expectedRevision: base.value.sourceRevision,
    expectedDigest: hash("zero"),
    authoredPatch: firstPatch,
  });
  expect(first.ok).toBe(true);
  const secondPatch = authoredPatch("zero", "second");
  const stale = await editing.editDocumentAsMember({
    memberId: "member_b",
    projectId: "project_1",
    connectorId: "connector_1",
    connectorEpoch: 1,
    workspaceId: "workspace_1",
    idempotencyKey: "edit_2",
    documentId: "doc_a",
    expectedRevision: base.value.sourceRevision,
    expectedDigest: hash("zero"),
    authoredPatch: secondPatch,
  });
  expect(stale.ok).toBe(false);
  if (!stale.ok) {
    expect(stale.error.code).toBe("SOURCE_REVISION_STALE");
    expect(stale.error.details).toEqual({
      authoredPatchDigest: secondPatch.digest,
      currentRevision: "2",
    });
  }
  expect(outline.body("doc_a")).toBe("first");
});
