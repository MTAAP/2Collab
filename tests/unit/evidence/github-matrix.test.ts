import { expect, test } from "bun:test";
import { deriveGitHubEvidenceStatus, GITHUB_REQUIREMENTS } from "../../evidence/github-matrix.ts";
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
