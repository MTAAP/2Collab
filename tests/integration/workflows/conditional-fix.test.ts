import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import migration13 from "../../../src/server/db/migrations/0013_workflows.sql" with {
  type: "text",
};
import migration14 from "../../../src/server/db/migrations/0014_workflow_execution.sql" with {
  type: "text",
};
import type { ResultRouterNode } from "../../../src/shared/contracts/workflow.ts";
import { routeTypedResult } from "../../../src/server/modules/workflows/conditions.ts";
import type { StartWorkflow } from "../../../src/server/modules/workflows/contract.ts";
import { createWorkflowEngine } from "../../../src/server/modules/workflows/workflow-engine.ts";
import { createWorkflowAuthority, startCommand } from "../../fixtures/workflows/engine.ts";

test("only the typed major-finding result selects Fix", () => {
  const router: ResultRouterNode = {
    kind: "RESULT_ROUTER",
    key: "review_result",
    sourceStepKey: "review",
    routes: { MAJOR_FINDING: "fix", CLEAN: "terminal" },
    fallbackTargetKey: "human-review",
  };
  const outcomes = ["MAJOR_FINDING", "CLEAN", "REVIEW PROSE SAYS MAJOR"].map((key) =>
    routeTypedResult(router, {
      stepOccurrenceId: "review-1",
      runId: "review-run",
      key,
      artifacts: [],
    }),
  );
  expect(outcomes.filter((outcome) => outcome.targetKey === "fix")).toHaveLength(1);
});

test("one typed major finding launches exactly one Fix Agent Run", async () => {
  const database = new Database(":memory:", { strict: true });
  database.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  for (let version = 1; version <= 12; version += 1)
    database.query("INSERT INTO schema_migrations VALUES (?, 0)").run(version);
  database.exec(migration13);
  database.exec(migration14);
  const fake = createWorkflowAuthority();
  const definition = {
    ...startCommand.definition,
    nodes: [
      { kind: "START" as const, key: "start" },
      {
        kind: "AGENT_RUN" as const,
        key: "implement",
        runTemplateVersionId: "implement_v1",
        resultKeys: ["READY_FOR_REVIEW"],
      },
      {
        kind: "AGENT_RUN" as const,
        key: "review",
        runTemplateVersionId: "review_v1",
        resultKeys: ["MAJOR_FINDING", "CLEAN"],
      },
      {
        kind: "RESULT_ROUTER" as const,
        key: "review_result",
        sourceStepKey: "review",
        routes: { MAJOR_FINDING: "fix", CLEAN: "done" },
        fallbackTargetKey: "human-review",
      },
      {
        kind: "AGENT_RUN" as const,
        key: "fix",
        runTemplateVersionId: "fix_v1",
        resultKeys: ["FIXED"],
      },
      { kind: "TERMINAL" as const, key: "done", outcome: "COMPLETED" as const },
      { kind: "HUMAN_DECISION" as const, key: "human-review", choices: ["APPROVE"] },
    ],
    transitions: [
      { from: "start", resultKey: "STARTED", to: "implement" },
      { from: "implement", resultKey: "READY_FOR_REVIEW", to: "review" },
      { from: "review", resultKey: "MAJOR_FINDING", to: "review_result" },
      { from: "review", resultKey: "CLEAN", to: "review_result" },
      { from: "review_result", resultKey: "MAJOR_FINDING", to: "fix" },
      { from: "review_result", resultKey: "CLEAN", to: "done" },
      { from: "review_result", resultKey: "FALLBACK", to: "human-review" },
      { from: "fix", resultKey: "FIXED", to: "done" },
    ],
    maximumRunCount: 3,
    cycleBounds: {},
  };
  const command = {
    ...startCommand,
    idempotencyKey: "conditional_start",
    workflowExecutionId: "conditional_workflow",
    schedulerActor: {
      ...startCommand.schedulerActor,
      workflowExecutionId: "conditional_workflow" as never,
    },
    definition,
    launches: { ...startCommand.launches, fix: startCommand.launches.implement },
  } as StartWorkflow;
  const engine = createWorkflowEngine({
    database,
    authority: fake.authority,
    clockMs: () => 100,
    allowInlineLaunchesForTesting: true,
  });
  await engine.start(command);
  await engine.tick();
  const accept = async (eventId: string, occurrenceId: string, key: string) => {
    const runId = database
      .query<{ agent_run_id: string }, [string]>(
        "SELECT agent_run_id FROM workflow_step_occurrences WHERE id = ?",
      )
      .get(occurrenceId)?.agent_run_id;
    if (!runId) throw new Error("MISSING_TEST_RUN");
    const execution = engine.inspect("conditional_workflow");
    if (!execution.ok) throw new Error("MISSING_TEST_WORKFLOW");
    return engine.accept({
      eventId,
      actor: command.schedulerActor,
      workflowExecutionId: "conditional_workflow",
      expectedRevision: execution.value.revision,
      stepOccurrenceId: occurrenceId,
      runId,
      result: { stepOccurrenceId: occurrenceId, runId, key, artifacts: [] },
    });
  };
  await accept("implemented", "implement-1", "READY_FOR_REVIEW");
  await engine.tick();
  const finding = await accept("reviewed", "review-1", "MAJOR_FINDING");
  const duplicateRevision = engine.inspect("conditional_workflow");
  if (!duplicateRevision.ok) throw new Error("MISSING_TEST_WORKFLOW");
  await engine.accept({
    eventId: "reviewed",
    actor: command.schedulerActor,
    workflowExecutionId: "conditional_workflow",
    expectedRevision: duplicateRevision.value.revision,
    stepOccurrenceId: "review-1",
    runId:
      database
        .query<{ agent_run_id: string }, []>(
          "SELECT agent_run_id FROM workflow_step_occurrences WHERE id = 'review-1'",
        )
        .get()?.agent_run_id ?? "missing",
    result: {
      stepOccurrenceId: "review-1",
      runId:
        database
          .query<{ agent_run_id: string }, []>(
            "SELECT agent_run_id FROM workflow_step_occurrences WHERE id = 'review-1'",
          )
          .get()?.agent_run_id ?? "missing",
      key: "MAJOR_FINDING",
      artifacts: [],
    },
  });
  expect(finding).toMatchObject({ ok: true, value: { currentNodeKey: "fix" } });
  await engine.tick();
  expect(fake.commands).toHaveLength(3);
  database.close();
});
