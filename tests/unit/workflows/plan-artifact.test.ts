import { expect, test } from "bun:test";
import { PlanArtifactSchema } from "../../../src/shared/contracts/plan-artifacts.ts";

export const validPlan = {
  approach: "Implement the bounded workflow through the shared authority seam.",
  assumptions: ["The exact repository revision remains available."],
  risks: ["A connector epoch may change before implementation."],
  affectedAreas: ["src/server/modules/workflows"],
  verificationStrategy: ["Run focused Bun tests and the package bar."],
  evidence: [{ kind: "REFERENCE", reference: "github:repo/pull/42", revision: "abc123" }],
} as const;

test("Plan Artifacts contain no runtime plan mode or hidden process state", () => {
  const artifact = PlanArtifactSchema.parse(validPlan);
  expect(artifact).toEqual(validPlan);
  expect(JSON.stringify(artifact)).not.toContain("planMode");
  expect(JSON.stringify(artifact)).not.toContain("sessionId");
});

test("Plan Artifacts reject private runtime and oversized evidence", () => {
  expect(() => PlanArtifactSchema.parse({ ...validPlan, sessionId: "private" })).toThrow();
  expect(() =>
    PlanArtifactSchema.parse({
      ...validPlan,
      evidence: Array.from({ length: 33 }, () => validPlan.evidence[0]),
    }),
  ).toThrow();
});
