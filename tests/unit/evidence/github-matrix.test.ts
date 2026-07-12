import { expect, test } from "bun:test";
import {
  deriveGitHubEvidenceStatus,
  GITHUB_LIVE_OBLIGATIONS,
  GITHUB_REQUIREMENTS,
  validateGitHubLiveEvidence,
} from "../../evidence/github-matrix.ts";
import { PHASE_EXIT_QUOTES } from "../../../scripts/evidence/evidence-envelope.ts";
test("GitHub matrix covers GHB-001 through GHB-015 and never promotes fixture proof", () => {
  expect(GITHUB_REQUIREMENTS).toHaveLength(15);
  expect(new Set(GITHUB_REQUIREMENTS).size).toBe(15);
  expect(
    deriveGitHubEvidenceStatus({
      requirement: "GHB-001",
      build: "build",
      gitRevision: "a".repeat(40),
      localTestsPassed: true,
      liveTestsPassed: false,
      reviewed: false,
    }),
  ).toBe("IN_PROGRESS_LIVE");
  expect(
    deriveGitHubEvidenceStatus({
      requirement: "GHB-001",
      build: "build",
      gitRevision: "a".repeat(40),
      localTestsPassed: true,
      liveTestsPassed: true,
      reviewed: false,
    }),
  ).not.toBe("PASS");
});

test("live GitHub proof requires unique provider-produced records including recovery cases", () => {
  expect(GITHUB_LIVE_OBLIGATIONS).toContain("MISSED_WEBHOOK_RECONCILED");
  expect(GITHUB_LIVE_OBLIGATIONS).toContain("LATE_LINK_CANONICALIZED");
  expect(GITHUB_LIVE_OBLIGATIONS).toContain("SCOPE_NARROWING_ENFORCED");
  const buildId = "build_0123456789abcdef";
  const evidence = {
    schemaVersion: 2 as const,
    approvalId: "approval_github_live",
    envelope: {
      schemaVersion: 1 as const,
      phase: "GITHUB" as const,
      buildId,
      repositoryRevision: "a".repeat(40),
      repositoryDirty: false,
      artifactSha256: "b".repeat(64),
      lockfileSha256: "c".repeat(64),
      manifestSha256: "d".repeat(64),
      testReports: [
        {
          reportId: "github_live_report",
          buildId,
          path: "artifacts/github-live.json",
          sha256: "e".repeat(64),
          runner: "PLAYWRIGHT" as const,
          generatedAt: "2026-07-11T12:00:00Z",
          result: "PASSED" as const,
          skipped: 0 as const,
          synthetic: false as const,
        },
      ],
      reviewers: [{ memberId: "member_reviewer", reviewedAt: "2026-07-11T13:00:00Z" }],
      canonicalExitQuote: PHASE_EXIT_QUOTES.GITHUB,
    },
    records: GITHUB_LIVE_OBLIGATIONS.map((obligation, index) => ({
      obligation,
      source: "PROVIDER" as const,
      providerResourceId: `provider_${index}`,
      collabResourceId: `collab_${index}`,
      auditEventId: `audit_${index}`,
      providerRevision: `sha:${"f".repeat(40)}`,
      observedAt: "2026-07-11T12:30:00Z",
    })),
  };
  expect(
    validateGitHubLiveEvidence(evidence, { buildId, approvalId: evidence.approvalId }).valid,
  ).toBe(true);
  expect(
    validateGitHubLiveEvidence(
      { ...evidence, records: evidence.records.slice(1) },
      { buildId, approvalId: evidence.approvalId },
    ).valid,
  ).toBe(false);
  expect(
    validateGitHubLiveEvidence(
      { ...evidence, records: [...evidence.records, evidence.records[0]] },
      { buildId, approvalId: evidence.approvalId },
    ).valid,
  ).toBe(false);
});
