import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
  deriveOutlineStatus,
  validateOutlineEvidence,
  OUTLINE_REQUIREMENTS,
  LIVE_OUTLINE_TEST_NAME,
  OUTLINE_LOCAL_OBLIGATIONS,
  validateLivePlaywrightReport,
} from "../../evidence/outline-matrix.ts";
import { PHASE_EXIT_QUOTES } from "../../../scripts/evidence/evidence-envelope.ts";
test("fixture-only evidence can never pass", () => {
  expect(
    deriveOutlineStatus({
      requirement: "OUT-001",
      build: "b",
      gitRevision: "1234567",
      collabIds: [],
      journey: "fixture",
      localPassed: true,
      livePassed: false,
    }),
  ).toBe("LOCAL_PROOF_COMPLETE");
});
test("requires every exact Outline row", () => {
  const rows = OUTLINE_REQUIREMENTS.map((requirement) => ({
    requirement,
    build: "build",
    gitRevision: "1234567",
    collabIds: [],
    journey: "local",
    localPassed: true,
    livePassed: false,
    localProofs: [{ ...OUTLINE_LOCAL_OBLIGATIONS[requirement], status: "PASSED" as const }],
  }));
  expect(validateOutlineEvidence(rows).valid).toBe(true);
  expect(validateOutlineEvidence(rows.slice(1)).valid).toBe(false);
});
test("rejects a claimed local pass without its exact named obligation", () => {
  const rows = OUTLINE_REQUIREMENTS.map((requirement) => ({
    requirement,
    build: "build",
    gitRevision: "1234567",
    collabIds: [],
    journey: "local",
    localPassed: true,
    livePassed: false,
    localProofs: [],
  }));
  expect(validateOutlineEvidence(rows).valid).toBe(false);
});
test("does not accept a claimed live pass without provider IDs, review, and validated live proof", () => {
  const rows = OUTLINE_REQUIREMENTS.map((requirement) => ({
    requirement,
    build: "build",
    gitRevision: "1234567",
    collabIds: [],
    journey: "live",
    localPassed: true,
    livePassed: true,
    reviewer: "reviewer",
  }));
  expect(validateOutlineEvidence(rows).valid).toBe(false);
  const first = rows[0];
  if (!first) throw new Error("expected evidence row");
  expect(deriveOutlineStatus(first)).toBe("IN_PROGRESS_LIVE");
});
test("parses the exact Playwright live obligation and rejects skips", () => {
  const report = (status: string, expected = "expected") => ({
    suites: [
      {
        specs: [
          {
            title: LIVE_OUTLINE_TEST_NAME,
            tests: [{ status: expected, results: [{ status }] }],
          },
        ],
      },
    ],
    errors: [],
  });
  const buildId = "build_0123456789abcdef";
  const input = (playwright: unknown) => ({
    schemaVersion: 2,
    report: playwright,
    envelope: {
      schemaVersion: 1,
      phase: "OUTLINE",
      buildId,
      repositoryRevision: "a".repeat(40),
      repositoryDirty: false,
      artifactSha256: "b".repeat(64),
      lockfileSha256: "c".repeat(64),
      manifestSha256: "d".repeat(64),
      testReports: [
        {
          reportId: "outline_live_report",
          buildId,
          path: "artifacts/outline-live.json",
          sha256: createHash("sha256").update(JSON.stringify(playwright)).digest("hex"),
          runner: "PLAYWRIGHT",
          generatedAt: "2026-07-11T12:00:00Z",
          result: "PASSED",
          skipped: 0,
          synthetic: false,
        },
      ],
      reviewers: [{ memberId: "member_reviewer", reviewedAt: "2026-07-11T13:00:00Z" }],
      canonicalExitQuote: PHASE_EXIT_QUOTES.OUTLINE,
    },
    journey: {
      source: "PROVIDER",
      journeyId: "journey_outline_live",
      workspaceId: "workspace_outline_live",
      approvalId: "approval_outline_live",
      memberIds: ["member_one", "member_two"],
      providerResourceIds: ["document_provider_1", "revision_provider_2"],
      collabResourceIds: ["document_collab_1", "proposal_collab_2"],
      auditEventIds: ["audit_outline_1", "audit_outline_2"],
      providerRevisions: ["f".repeat(40), "1".repeat(40)],
      completedAt: "2026-07-11T12:30:00Z",
    },
  });
  const expected = {
    buildId,
    workspaceId: "workspace_outline_live",
    approvalId: "approval_outline_live",
  };
  expect(validateLivePlaywrightReport(input(report("passed")), expected).valid).toBe(true);
  expect(validateLivePlaywrightReport(input(report("skipped", "skipped")), expected).valid).toBe(
    false,
  );
  expect(
    validateLivePlaywrightReport(input(report("passed")), { ...expected, buildId: "wrong_build" })
      .valid,
  ).toBe(false);
  expect(validateLivePlaywrightReport({ suites: [] }).valid).toBe(false);
});
