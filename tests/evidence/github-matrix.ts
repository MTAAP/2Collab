import { z } from "zod";
import {
  PHASE_EXIT_QUOTES,
  validateEvidenceEnvelope,
} from "../../scripts/evidence/evidence-envelope.ts";

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

export function validateGitHubEvidence(records: readonly GitHubEvidenceRecord[]): Readonly<{
  valid: boolean;
  statuses: Readonly<Record<string, GitHubEvidenceStatus>>;
}> {
  const statuses: Record<string, GitHubEvidenceStatus> = {};
  for (const record of records) {
    if (statuses[record.requirement]) return { valid: false, statuses };
    statuses[record.requirement] = deriveGitHubEvidenceStatus(record);
  }
  return {
    valid:
      records.length === GITHUB_REQUIREMENTS.length &&
      GITHUB_REQUIREMENTS.every(
        (requirement) => statuses[requirement] && statuses[requirement] !== "FAIL",
      ),
    statuses,
  };
}

export const GITHUB_LIVE_OBLIGATIONS = [
  "PLANNING_PROJECTIONS",
  "MUTATION_CREATE_ISSUE",
  "MUTATION_EDIT_ISSUE",
  "MUTATION_ADD_COMMENT",
  "MUTATION_SET_LABELS",
  "MUTATION_SET_ASSIGNEES",
  "MUTATION_SET_MILESTONE",
  "MUTATION_SET_ISSUE_STATE",
  "MUTATION_CREATE_MILESTONE",
  "MUTATION_EDIT_MILESTONE",
  "MUTATION_ADD_PROJECT_ITEM",
  "MUTATION_REMOVE_PROJECT_ITEM",
  "MUTATION_SET_PROJECT_FIELD",
  "MUTATION_MOVE_PROJECT_ITEM",
  "ASSIGNMENT_DELEGATION",
  "STALE_CAS_REJECTED",
  "DELIVERY_CLOSING_REFERENCE",
  "DELIVERY_MERGED_AND_CLOSED",
  "REVIEWER_APPROVED",
  "CHECK_EXACT_SHA",
  "CHECK_FAILURE_BLOCKED",
  "DIFF_AND_COLLISION_EVIDENCE",
  "MISSED_WEBHOOK_RECONCILED",
  "LATE_LINK_CANONICALIZED",
  "SCOPE_NARROWING_ENFORCED",
] as const;

const ProviderRecordSchema = z
  .object({
    obligation: z.enum(GITHUB_LIVE_OBLIGATIONS),
    source: z.literal("PROVIDER"),
    providerResourceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:#/-]{2,255}$/),
    collabResourceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:#/-]{2,255}$/),
    auditEventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:#/-]{2,255}$/),
    providerRevision: z.string().regex(/^(sha:)?[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const GitHubLiveEvidenceSchema = z
  .object({
    schemaVersion: z.literal(2),
    approvalId: z.string().regex(/^approval_[A-Za-z0-9_-]{1,119}$/),
    envelope: z.unknown(),
    records: z.array(ProviderRecordSchema),
  })
  .strict();

export function validateGitHubLiveEvidence(
  input: unknown,
  expected: Readonly<{ buildId: string; approvalId: string }>,
): Readonly<{ valid: boolean; reason?: string }> {
  const parsed = GitHubLiveEvidenceSchema.safeParse(input);
  if (!parsed.success) return { valid: false, reason: "LIVE_GITHUB_EVIDENCE_STRUCTURE_INVALID" };
  if (parsed.data.approvalId !== expected.approvalId)
    return { valid: false, reason: "LIVE_GITHUB_APPROVAL_MISMATCH" };
  const envelope = validateEvidenceEnvelope(parsed.data.envelope, {
    phase: "GITHUB",
    buildId: expected.buildId,
    canonicalExitQuote: PHASE_EXIT_QUOTES.GITHUB,
  });
  if (!envelope.valid) return { valid: false, reason: envelope.reasons[0] };
  const obligations = parsed.data.records.map((record) => record.obligation);
  if (
    obligations.length !== GITHUB_LIVE_OBLIGATIONS.length ||
    new Set(obligations).size !== obligations.length ||
    !GITHUB_LIVE_OBLIGATIONS.every((obligation) => obligations.includes(obligation))
  )
    return { valid: false, reason: "LIVE_GITHUB_OBLIGATION_SET_INVALID" };
  for (const key of ["providerResourceId", "collabResourceId", "auditEventId"] as const)
    if (
      new Set(parsed.data.records.map((record) => record[key])).size !== parsed.data.records.length
    )
      return { valid: false, reason: `LIVE_GITHUB_${key.toUpperCase()}_DUPLICATE` };
  return { valid: true };
}
