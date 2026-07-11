import { expect, test } from "bun:test";
import { createFederatedSearch } from "../../../src/server/modules/federated-search/search.ts";
import { StrictOutlineContentAdapter } from "../../fixtures/outline/strict-outline-adapter.ts";

const scope = {
  projectId: "project_1" as never,
  connectorId: "connector_1" as never,
  connectorEpoch: 1,
  references: ["OUTLINE_COLLECTION:allowed"],
  operations: ["SEARCH", "READ"],
};

test("search returns bounded live references and omits denied collections", async () => {
  const outline = StrictOutlineContentAdapter.seed({
    documents: [
      { id: "doc_a", collectionId: "allowed", title: "Allowed", body: "needle public" },
      { id: "doc_b", collectionId: "denied", title: "Denied", body: "needle secret" },
    ],
  });
  const result = await createFederatedSearch(outline).search({
    actor: { kind: "MEMBER", memberId: "member_1" },
    scope,
    query: {
      query: "needle",
      providerLimit: 16,
      resultLimit: 10,
      maximumTotalSnippetBytes: 1024,
      timeoutMs: 1000,
    },
  });
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.value.results.map((item) => item.reference.documentId)).toEqual(["doc_a"]);
});
