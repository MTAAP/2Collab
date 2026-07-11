import { expect, test } from "bun:test";
import { evaluateProposalRevision } from "../../../src/server/modules/documents/proposals.ts";
test("never applies a proposal across an external revision", () => {
  const proposal = {
    proposalId: "p" as never,
    projectId: "project" as never,
    connectorId: "connector" as never,
    connectorEpoch: 1,
    documentId: "doc" as never,
    runId: "run" as never,
    attemptId: "attempt" as never,
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
    conflictId: "conflict",
    now: 1,
  });
  expect(result.ok && result.value.kind).toBe("CONFLICT");
});
