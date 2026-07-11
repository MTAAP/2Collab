import { expect, test } from "bun:test";
import { acceptPlanArtifact } from "../../../src/server/modules/workflows/planning.ts";
import { validPlan } from "../../unit/workflows/plan-artifact.test.ts";

test("a portable Plan Artifact crosses runtime and runner choices", () => {
  expect(
    acceptPlanArtifact({
      workflowExecutionId: "workflow_1",
      stepOccurrenceId: "plan-1",
      repositoryMode: "INSPECT_ONLY",
      artifact: validPlan,
      producer: { runtime: "CLAUDE", runnerId: "runner_a", host: "ORCA", interaction: "HEADLESS" },
      consumer: { runtime: "CODEX", runnerId: "runner_b", host: "NATIVE", interaction: "HEADLESS" },
    }),
  ).toMatchObject({ ok: true, value: { artifact: validPlan } });
});

test("planning is inspect-only", () => {
  expect(
    acceptPlanArtifact({
      workflowExecutionId: "workflow_1",
      stepOccurrenceId: "plan-1",
      repositoryMode: "MUTATING",
      artifact: validPlan,
      producer: { runtime: "CLAUDE", runnerId: "runner_a", host: "ORCA", interaction: "HEADLESS" },
      consumer: { runtime: "CODEX", runnerId: "runner_b", host: "NATIVE", interaction: "HEADLESS" },
    }),
  ).toMatchObject({ ok: false, error: { code: "PLAN_REPOSITORY_MODE_INVALID" } });
});
