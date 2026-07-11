import { expect, test } from "bun:test";
import {
  deriveOutlineStatus,
  validateOutlineEvidence,
  OUTLINE_REQUIREMENTS,
  LIVE_OUTLINE_TEST_NAME,
  OUTLINE_LOCAL_OBLIGATIONS,
  validateLivePlaywrightReport,
} from "../../evidence/outline-matrix.ts";
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
  expect(validateLivePlaywrightReport(report("passed")).valid).toBe(true);
  expect(validateLivePlaywrightReport(report("skipped", "skipped")).valid).toBe(false);
  expect(validateLivePlaywrightReport({ suites: [] }).valid).toBe(false);
});
