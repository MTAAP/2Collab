import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import migration15 from "../../../src/server/db/migrations/0015_gates_telemetry.sql" with {
  type: "text",
};
import {
  acceptPlanArtifact,
  createPlanArtifactStore,
} from "../../../src/server/modules/workflows/planning.ts";
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

test("Plan Artifacts are immutable engine truth across restart", () => {
  const database = new Database(":memory:", { strict: true });
  database.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  for (let version = 1; version <= 14; version += 1)
    database.query("INSERT INTO schema_migrations VALUES (?, 0)").run(version);
  database.exec(migration15);
  const command = {
    workflowExecutionId: "workflow_1",
    stepOccurrenceId: "plan-1",
    repositoryMode: "INSPECT_ONLY" as const,
    artifact: validPlan,
    producer: {
      runtime: "CLAUDE" as const,
      runnerId: "runner_a",
      host: "ORCA" as const,
      interaction: "HEADLESS" as const,
    },
    consumer: {
      runtime: "CODEX" as const,
      runnerId: "runner_b",
      host: "NATIVE" as const,
      interaction: "HEADLESS" as const,
    },
  };
  expect(createPlanArtifactStore({ database, clock: () => 100 }).accept(command)).toMatchObject({
    ok: true,
  });
  expect(
    createPlanArtifactStore({ database, clock: () => 200 }).read("workflow_1", "plan-1"),
  ).toMatchObject({ artifact: validPlan, producer: { runtime: "CLAUDE" } });
  expect(
    createPlanArtifactStore({ database, clock: () => 200 }).accept({
      ...command,
      artifact: { ...validPlan, approach: "A conflicting replacement" },
    }),
  ).toMatchObject({ ok: false, error: { code: "PLAN_ARTIFACT_CONFLICT" } });
  database.close();
});
