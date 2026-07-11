import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { StrictOutlineContentAdapter } from "../../fixtures/outline/strict-outline-adapter.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex") as never;
const patch = (from: string, to: string) => {
  const value = `@@ -1,1 +1,1 @@\n-${from}\n+${to}`;
  return { format: "UNIFIED_TEXT_PATCH_V1" as const, value, digest: hash(value) };
};
const command = (mutation: object, revision: string, digest: string) => ({
  projectId: "project_1" as never,
  connectorId: "connector_1" as never,
  connectorEpoch: 1,
  idempotencyKey: crypto.randomUUID(),
  precondition: {
    kind: "EXACT_REVISION" as const,
    sourceRevision: revision,
    comparableDigest: digest as never,
  },
  actionDigest: "a".repeat(64) as never,
  mutation,
});
const authorization = (id: string) => ({
  kind: "CONNECTOR_OPERATION" as const,
  id,
  proof: "proof",
  projectId: "project_1" as never,
  connectorId: "connector_1" as never,
  connectorEpoch: 1,
  reference: "doc_a",
  operation: "EDIT_CONTENT",
  actionDigest: "a".repeat(64) as never,
  expiresAt: Date.now() + 1_000,
});

test("keeps delegated member and bot authority distinct", async () => {
  const outline = StrictOutlineContentAdapter.seed({
    documents: [{ id: "doc_a", collectionId: "allowed", title: "A", body: "zero" }],
  });
  await outline.mutate(
    authorization("mem_a"),
    command(
      { kind: "EDIT_DOCUMENT_AS_MEMBER", documentId: "doc_a", authoredPatch: patch("zero", "one") },
      "1",
      hash("zero"),
    ) as never,
  );
  await outline.mutate(
    authorization("bot"),
    command(
      {
        kind: "EDIT_DOCUMENT_AS_BOT",
        documentId: "doc_a",
        authoredPatch: patch("one", "two"),
        provenance: {
          runId: "run_a",
          attemptId: "attempt_a",
          grantId: "grant_a",
          grantRevision: 1,
          grantorMemberId: "mem_a",
          connectorEpoch: 1,
          editedSourceRevision: "2",
        },
      },
      "2",
      hash("one"),
    ) as never,
  );
  expect(outline.calls.map((call) => call.actor).filter(Boolean)).toEqual([
    "OUTLINE_MEMBER:mem_a",
    "OUTLINE_BOT:run_a",
  ]);
});
