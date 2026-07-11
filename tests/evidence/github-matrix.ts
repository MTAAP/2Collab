export const GITHUB_REQUIREMENTS = Array.from(
  { length: 15 },
  (_, index) => `GHB-${String(index + 1).padStart(3, "0")}`,
) as readonly string[];
export type GitHubEvidenceStatus =
  | "NOT_STARTED"
  | "LOCAL_PROOF_COMPLETE"
  | "IN_PROGRESS_LIVE"
  | "BLOCKED_ENV"
  | "PASS"
  | "FAIL";
export type GitHubEvidenceRecord = Readonly<{
  requirement: string;
  build: string;
  gitRevision: string;
  localTestsPassed: boolean;
  liveTestsPassed: boolean;
  reviewed: boolean;
  blocked?: string;
}>;
export function deriveGitHubEvidenceStatus(record: GitHubEvidenceRecord): GitHubEvidenceStatus {
  if (!GITHUB_REQUIREMENTS.includes(record.requirement) || !record.build || !record.gitRevision)
    return "FAIL";
  if (!record.localTestsPassed) return record.blocked ? "BLOCKED_ENV" : "NOT_STARTED";
  if (!record.liveTestsPassed) return record.blocked ? "BLOCKED_ENV" : "IN_PROGRESS_LIVE";
  return record.reviewed ? "PASS" : "IN_PROGRESS_LIVE";
}
