import { expect, test } from "bun:test";
import {
  deriveOutlineStatus,
  validateOutlineEvidence,
  OUTLINE_REQUIREMENTS,
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
  }));
  expect(validateOutlineEvidence(rows).valid).toBe(true);
  expect(validateOutlineEvidence(rows.slice(1)).valid).toBe(false);
});
