import { expect, test } from "bun:test";
import { evaluateProposalRevision } from "../../src/server/modules/documents/proposals.ts";
test("an external edit always produces conflict disposition", () => {
  const proposal = {
    proposalId: "p" as never,
    projectId: "p" as never,
    connectorId: "c" as never,
    connectorEpoch: 1,
    documentId: "d" as never,
    runId: "r" as never,
    attemptId: "a" as never,
    baseRevision: "1",
    baseDigest: "a".repeat(64) as never,
    authoredPatch: {
      format: "UNIFIED_TEXT_PATCH_V1" as const,
      value: "@@ -1,1 +1,1 @@\n-a\n+b",
      digest: "b".repeat(64) as never,
    },
    createdAt: 0,
  };
  const result = evaluateProposalRevision({
    proposal,
    currentRevision: "2",
    currentDigest: "c".repeat(64),
    conflictId: "x",
    now: 2,
  });
  expect(result.ok && result.value.kind).toBe("CONFLICT");
});
