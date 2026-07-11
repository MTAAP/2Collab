import type { GitHubCheckObservation } from "../../../shared/contracts/github.ts";
import type { Result } from "../../../shared/contracts/result.ts";

export type PublishedGitCheckReference = Readonly<{
  repositoryId: string;
  remoteIdentity: string;
  commitSha: string;
  scopeDigest: string;
  requiredCheckName: string;
}>;
export type GitHubCheckEvidence = Readonly<{
  checkRunId: string;
  repositoryId: string;
  remoteIdentity: string;
  commitSha: string;
  checkName: string;
  conclusion: GitHubCheckObservation["conclusion"];
  observedAt: number;
}>;
export function evaluateCheck(
  observation: GitHubCheckObservation,
  published: PublishedGitCheckReference,
): Result<GitHubCheckEvidence> {
  if (
    observation.scopeDigest !== published.scopeDigest ||
    observation.repositoryId !== published.repositoryId ||
    observation.commitSha !== published.commitSha ||
    observation.checkName !== published.requiredCheckName ||
    !observation.fresh
  )
    return {
      ok: false,
      error: {
        code: "GATE_EVALUATION_STALE",
        message: "GitHub check observation is stale.",
        retry: "REFRESH",
      },
    };
  return {
    ok: true,
    value: {
      checkRunId: observation.checkRunId,
      repositoryId: observation.repositoryId,
      remoteIdentity: published.remoteIdentity,
      commitSha: observation.commitSha,
      checkName: observation.checkName,
      conclusion: observation.conclusion,
      observedAt: observation.observedAt,
    },
  };
}
