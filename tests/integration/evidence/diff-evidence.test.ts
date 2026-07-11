import { expect, test } from "bun:test";
import {
  DiffEvidenceSchema,
  requireDeliverableDiffEvidence,
} from "../../../src/server/modules/evidence/diff-evidence.ts";
import { createChangedPathSnapshot } from "../../../src/runner/repository/changed-paths.ts";

test("diff evidence is bounded and rejects raw diffs and malicious paths", () => {
  const valid = {
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    observedAt: 1,
    filesChanged: 1,
    additions: 2,
    deletions: 1,
    paths: ["src/a.ts"],
    truncated: false,
    verificationEvidenceIds: ["evidence_1"],
  };
  expect(requireDeliverableDiffEvidence(valid).ok).toBe(true);
  expect(DiffEvidenceSchema.safeParse({ ...valid, rawDiff: "secret source" }).success).toBe(false);
  for (const path of [
    "../secret",
    "/etc/passwd",
    "C:/secret",
    "src\\secret",
    "src/../secret",
    "-option",
  ])
    expect(() =>
      createChangedPathSnapshot({
        runId: "run_1",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        observedAt: 1,
        paths: [path],
      }),
    ).toThrow("CHANGED_PATH_INVALID");
});
