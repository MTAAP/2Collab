export const OUTLINE_REQUIREMENTS = [
  "OUT-001",
  "OUT-002",
  "OUT-003",
  "OUT-004",
  "OUT-005",
  "OUT-006",
  "OUT-007",
  "OUT-008",
  "OUT-009",
  "OUT-010",
] as const;
export type OutlineEvidenceStatus =
  | "NOT_STARTED"
  | "LOCAL_PROOF_COMPLETE"
  | "IN_PROGRESS_LIVE"
  | "BLOCKED_ENV"
  | "PASS"
  | "FAIL";
export type OutlineEvidenceRow = Readonly<{
  requirement: (typeof OUTLINE_REQUIREMENTS)[number];
  build: string;
  gitRevision: string;
  providerRevision?: string;
  collabIds: readonly string[];
  journey: string;
  localPassed: boolean;
  livePassed: boolean;
  reviewer?: string;
  blocker?: string;
}>;
export function deriveOutlineStatus(row: OutlineEvidenceRow): OutlineEvidenceStatus {
  if (row.blocker) return "BLOCKED_ENV";
  if (!row.localPassed) return "NOT_STARTED";
  if (!row.livePassed) return "LOCAL_PROOF_COMPLETE";
  return row.reviewer ? "PASS" : "IN_PROGRESS_LIVE";
}
export function validateOutlineEvidence(
  rows: readonly OutlineEvidenceRow[],
): Readonly<{ valid: boolean; statuses: Readonly<Record<string, OutlineEvidenceStatus>> }> {
  const statuses = Object.fromEntries(
    rows.map((row) => [row.requirement, deriveOutlineStatus(row)]),
  );
  return {
    valid:
      OUTLINE_REQUIREMENTS.every((requirement) => requirement in statuses) &&
      rows.every((row) => row.build.length > 0 && row.gitRevision.length >= 7),
    statuses,
  };
}
