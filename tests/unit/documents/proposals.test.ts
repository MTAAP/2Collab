import { expect, test } from "bun:test";
import { evaluateProposalRevision } from "../../../src/server/modules/documents/proposals.ts";
test("creates a reference-only conflict without fetched current body", () => {
  const proposal = {
    proposalId: "proposal_a" as never,
    projectId: "project_a" as never,
    connectorId: "connector_a" as never,
    connectorEpoch: 1,
    documentId: "doc_a" as never,
    runId: "run_a" as never,
    attemptId: "attempt_a" as never,
    baseRevision: "7",
    baseDigest: "a".repeat(64) as never,
    authoredPatch: {
      format: "UNIFIED_TEXT_PATCH_V1" as const,
      value: "@@ -1,1 +1,1 @@\n-old\n+agent",
      digest: "b".repeat(64) as never,
    },
    createdAt: 0,
  };
  const result = evaluateProposalRevision({
    proposal,
    currentRevision: "8",
    currentDigest: "c".repeat(64),
    conflictId: "conflict_a",
    now: 1,
  });
  expect(result.ok).toBe(true);
  expect(JSON.stringify(result)).not.toContain("external body");
  if (result.ok)
    expect(result.value).toEqual(
      expect.objectContaining({
        kind: "CONFLICT",
        conflict: expect.objectContaining({ currentRevision: "8" }),
      }),
    );
});
