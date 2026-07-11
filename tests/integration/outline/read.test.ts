import { expect, test } from "bun:test";
import { createOutlineReferenceProvider } from "../../../src/server/modules/context/outline-reference-provider.ts";
import { StrictOutlineContentAdapter } from "../../fixtures/outline/strict-outline-adapter.ts";

const scope = {
  projectId: "project_1" as never,
  connectorId: "connector_1" as never,
  connectorEpoch: 1,
  references: ["OUTLINE_COLLECTION:allowed"],
  operations: ["READ"],
};

test("returns the current document body and stores only a safe projection", async () => {
  const canary = `outline-read-${crypto.randomUUID()}`;
  const outline = StrictOutlineContentAdapter.seed({
    documents: [{ id: "doc_a", collectionId: "allowed", title: "A", body: canary, revision: 7 }],
  });
  const projections: unknown[] = [];
  const provenance: unknown[] = [];
  const provider = createOutlineReferenceProvider({
    outline,
    projections: {
      async upsert(value) {
        projections.push(value);
      },
    },
    provenance: {
      async record(value) {
        provenance.push(value);
      },
    },
  });
  const result = await provider.get({
    actor: { kind: "MEMBER", memberId: "member_1" },
    scope,
    reference: {
      kind: "OUTLINE_DOCUMENT",
      workspaceId: "workspace_1" as never,
      documentId: "doc_a" as never,
    },
  });
  expect(result.ok && result.value.value.body).toBe(canary);
  expect(JSON.stringify({ projections, provenance })).not.toContain(canary);
  expect(projections).toEqual([
    expect.objectContaining({ documentId: "doc_a", sourceRevision: "7" }),
  ]);
});
