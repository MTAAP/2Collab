import type { Result } from "../../../shared/contracts/result.ts";

export function evaluateMutationGuard(
  input: Readonly<{
    coordinationRecordId: string;
    runId: string;
    heldByRunId?: string;
    overrideAuditId?: string;
    repositoryId: string;
    intendedBranch: string;
    activeBranches: readonly Readonly<{
      runId: string;
      repositoryId: string;
      intendedBranch: string;
    }>[];
  }>,
): Result<Readonly<{ overridden: boolean }>> {
  if (
    input.activeBranches.some(
      (item) =>
        item.runId !== input.runId &&
        item.repositoryId === input.repositoryId &&
        item.intendedBranch === input.intendedBranch,
    )
  )
    return {
      ok: false,
      error: {
        code: "BRANCH_COLLISION",
        message: "Target branch is already active.",
        retry: "REFRESH",
      },
    };
  if (input.heldByRunId && input.heldByRunId !== input.runId && !input.overrideAuditId)
    return {
      ok: false,
      error: {
        code: "MUTATION_GUARD_HELD",
        message: "Coordination Record already has a mutating run.",
        retry: "REFRESH",
      },
    };
  return { ok: true, value: { overridden: Boolean(input.overrideAuditId) } };
}
