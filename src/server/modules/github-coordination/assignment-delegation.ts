import type { GitHubProjection } from "../../../shared/contracts/github.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { Observed } from "../connectors/contract.ts";

export type AssignmentDelegationResult<T> = Readonly<{
  assignment: Result<Observed<GitHubProjection>>;
  delegation: Result<T>;
}>;

function rejected(code: string): Result<never> {
  return { ok: false, error: { code, message: "Operation failed.", retry: "REFRESH" } };
}

function settled<T>(result: PromiseSettledResult<Result<T>>, code: string): Result<T> {
  return result.status === "fulfilled" ? result.value : rejected(code);
}

export async function assignAndDelegate<T>(
  input: Readonly<{
    assign: () => Promise<Result<Observed<GitHubProjection>>>;
    delegate: () => Promise<Result<T>>;
  }>,
): Promise<AssignmentDelegationResult<T>> {
  const [assignment, delegation] = await Promise.allSettled([input.assign(), input.delegate()]);
  return {
    assignment: settled(assignment, "GITHUB_ASSIGNMENT_FAILED"),
    delegation: settled(delegation, "DELEGATION_FAILED"),
  };
}
