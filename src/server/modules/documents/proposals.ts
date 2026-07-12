import type {
  DocumentConflict,
  DocumentProposal,
} from "../../../shared/contracts/document-proposals.ts";
import type { Result } from "../../../shared/contracts/result.ts";
export function evaluateProposalRevision(
  input: Readonly<{
    proposal: DocumentProposal;
    currentRevision: string;
    currentDigest: string;
    now: number;
    conflictId: string;
  }>,
): Result<Readonly<{ kind: "APPLY" } | { kind: "CONFLICT"; conflict: DocumentConflict }>> {
  if (
    input.currentRevision === input.proposal.baseRevision &&
    input.currentDigest === input.proposal.baseDigest
  )
    return { ok: true, value: { kind: "APPLY" } };
  return {
    ok: true,
    value: {
      kind: "CONFLICT",
      conflict: {
        conflictId: input.conflictId as never,
        proposalId: input.proposal.proposalId,
        currentRevision: input.currentRevision,
        currentDigest: input.currentDigest as never,
        detectedAt: input.now,
      },
    },
  };
}
