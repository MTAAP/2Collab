import { z } from "zod";

const OpaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Revision = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const UtcInstant = z.string().datetime({ offset: true });

export const PHASE_EXIT_QUOTES = {
  FOUNDATION:
    "Exit when both owners can start headless and interactive Claude or Codex attempts on their own trusted machines from web and CLI; exact permit replay and stale-policy cases fail; a lost runner produces run `WAITING` plus attempt `LOST`; server backup and isolated restore drills pass; and one week of dogfood produces no need for direct database repair.",
  GITHUB:
    "Exit when a real connected issue can be triaged, assigned, delegated, implemented, published with a closing reference, reviewed, merged, and observed closing from GitHub without Collab fabricating source state; missed webhook reconciliation, stale replace-style edits, late source linking, and connector scope narrowing are exercised successfully.",
  OUTLINE:
    "Exit when two members can co-edit an Outline document through Collab with correct native attribution; an agent can iterate only inside an exact grant; concurrent external edits create a conflict proposal; revoked member and bot grants stop new external operations; and no raw document body appears in run logs, backups outside encrypted connector storage, or runner outboxes.",
  AUTOMATION:
    "Exit when the team dogfoods **Implementation -> parallel Claude and Codex review -> conditional Fix -> Terminal** on a real pull request with different runtimes or models per step; validation catches missing terminal and fix paths; restart and duplicate events create no duplicate run; pause and waiting do not extend the deadline; and no process remains parked for a human decision.",
} as const;

export const TestReportProvenanceSchema = z
  .object({
    reportId: OpaqueId,
    buildId: OpaqueId,
    path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]{2,255}$/),
    sha256: Sha256,
    runner: z.enum(["BUN", "PLAYWRIGHT", "DRILL", "OPERATOR"]),
    generatedAt: UtcInstant,
    result: z.literal("PASSED"),
    skipped: z.literal(0),
    synthetic: z.literal(false),
  })
  .strict();

export const EvidenceEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    phase: z.enum(["FOUNDATION", "GITHUB", "OUTLINE", "AUTOMATION"]),
    buildId: OpaqueId,
    repositoryRevision: Revision,
    repositoryDirty: z.literal(false),
    artifactSha256: Sha256,
    lockfileSha256: Sha256,
    manifestSha256: Sha256,
    testReports: z.array(TestReportProvenanceSchema).min(1),
    reviewers: z.array(z.object({ memberId: OpaqueId, reviewedAt: UtcInstant }).strict()).min(1),
    canonicalExitQuote: z.string().min(40).max(1_500),
  })
  .strict();

export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelopeSchema>;

export function validateEvidenceEnvelope(
  input: unknown,
  expected: Readonly<{
    phase: EvidenceEnvelope["phase"];
    buildId?: string;
    canonicalExitQuote?: string;
  }>,
): Readonly<{ valid: boolean; reasons: readonly string[]; envelope?: EvidenceEnvelope }> {
  const parsed = EvidenceEnvelopeSchema.safeParse(input);
  if (!parsed.success) return { valid: false, reasons: ["EVIDENCE_ENVELOPE_INVALID"] };
  const envelope = parsed.data;
  const reasons: string[] = [];
  if (envelope.phase !== expected.phase) reasons.push("EVIDENCE_PHASE_MISMATCH");
  if (expected.buildId && envelope.buildId !== expected.buildId)
    reasons.push("EVIDENCE_BUILD_MISMATCH");
  if (expected.canonicalExitQuote && envelope.canonicalExitQuote !== expected.canonicalExitQuote)
    reasons.push("EVIDENCE_EXIT_QUOTE_MISMATCH");
  if (envelope.testReports.some((report) => report.buildId !== envelope.buildId))
    reasons.push("EVIDENCE_REPORT_BUILD_MISMATCH");
  if (
    new Set(envelope.testReports.map((report) => report.reportId)).size !==
    envelope.testReports.length
  )
    reasons.push("EVIDENCE_REPORT_DUPLICATE");
  if (
    new Set(envelope.reviewers.map((reviewer) => reviewer.memberId)).size !==
    envelope.reviewers.length
  )
    reasons.push("EVIDENCE_REVIEWER_DUPLICATE");
  return reasons.length ? { valid: false, reasons } : { valid: true, reasons, envelope };
}
