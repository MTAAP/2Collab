import type { GitHubIssueRef, GitHubProjection } from "../../../shared/contracts/github.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { Observed } from "../connectors/contract.ts";

function failure(code: string): Result<never> {
  return {
    ok: false,
    error: { code, message: "GitHub delivery reference is unavailable.", retry: "REFRESH" },
  };
}

export function closingReference(
  input: Readonly<{
    issue: GitHubIssueRef;
    repository: Observed<GitHubProjection>;
  }>,
): Result<string> {
  if (
    input.repository.freshness !== "FRESH" ||
    input.repository.value.kind !== "REPOSITORY" ||
    input.repository.value.repositoryId !== input.issue.repositoryId
  )
    return failure("GITHUB_REPOSITORY_PROJECTION_STALE");
  return {
    ok: true,
    value: `Closes ${input.repository.value.ownerLogin}/${input.repository.value.name}#${input.issue.number}`,
  };
}

export type DeliveryObservation = Readonly<{
  pullRequestMerged: boolean;
  issueState: "OPEN" | "CLOSED" | "UNAVAILABLE";
  delivered: boolean;
}>;

export function observeDelivery(
  input: Readonly<{ pullRequest: Observed<GitHubProjection>; issue: Observed<GitHubProjection> }>,
): DeliveryObservation {
  const pullRequestMerged =
    input.pullRequest.value.kind === "PULL_REQUEST" && input.pullRequest.value.merged;
  const issueState = input.issue.value.kind === "ISSUE" ? input.issue.value.state : "UNAVAILABLE";
  return { pullRequestMerged, issueState, delivered: pullRequestMerged && issueState === "CLOSED" };
}
