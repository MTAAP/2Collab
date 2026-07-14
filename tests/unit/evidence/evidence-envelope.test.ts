import { expect, test } from "bun:test";
import { validateEvidenceEnvelope } from "../../../scripts/evidence/evidence-envelope.ts";

const exit = "Exit when externally observed behavior matches the canonical product criterion.";
const valid = {
  schemaVersion: 1 as const,
  phase: "GITHUB" as const,
  buildId: "build_0123456789abcdef",
  repositoryRevision: "a".repeat(40),
  repositoryDirty: false,
  artifactSha256: "b".repeat(64),
  lockfileSha256: "c".repeat(64),
  manifestSha256: "d".repeat(64),
  testReports: [
    {
      reportId: "report_github_live",
      buildId: "build_0123456789abcdef",
      path: "artifacts/github-live.json",
      sha256: "e".repeat(64),
      runner: "PLAYWRIGHT" as const,
      generatedAt: "2026-07-11T12:00:00Z",
      result: "PASSED" as const,
      skipped: 0,
      synthetic: false,
    },
  ],
  reviewers: [{ memberId: "member_reviewer", reviewedAt: "2026-07-11T13:00:00Z" }],
  canonicalExitQuote: exit,
};

test("accepts a clean, reviewed, build-bound evidence envelope", () => {
  expect(
    validateEvidenceEnvelope(valid, {
      phase: "GITHUB",
      buildId: valid.buildId,
      canonicalExitQuote: exit,
    }).valid,
  ).toBe(true);
});

test("rejects dirty, synthetic, skipped, duplicate, and wrong-build reports", () => {
  const invalid = [
    { ...valid, repositoryDirty: true },
    { ...valid, testReports: [{ ...valid.testReports[0], synthetic: true }] },
    { ...valid, testReports: [{ ...valid.testReports[0], skipped: 1 }] },
    { ...valid, testReports: [valid.testReports[0], valid.testReports[0]] },
    {
      ...valid,
      testReports: [{ ...valid.testReports[0], buildId: "build_wrong_revision" }],
    },
  ];
  for (const envelope of invalid)
    expect(
      validateEvidenceEnvelope(envelope, {
        phase: "GITHUB",
        buildId: valid.buildId,
        canonicalExitQuote: exit,
      }).valid,
    ).toBe(false);
});
