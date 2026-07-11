import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import migration13 from "../../../src/server/db/migrations/0013_workflows.sql" with {
  type: "text",
};
import migration14 from "../../../src/server/db/migrations/0014_workflow_execution.sql" with {
  type: "text",
};
import { createWorkflowEngine } from "../../../src/server/modules/workflows/workflow-engine.ts";
import { createWorkflowAuthority, startCommand } from "../../fixtures/workflows/engine.ts";

test("duplicate starts and terminal events cannot launch twice", async () => {
  const database = new Database(":memory:", { strict: true });
  database.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  for (let version = 1; version <= 12; version += 1)
    database.query("INSERT INTO schema_migrations VALUES (?, 0)").run(version);
  database.exec(migration13);
  database.exec(migration14);
  const fake = createWorkflowAuthority();
  const engine = createWorkflowEngine({
    database,
    authority: fake.authority,
    clock: () => 100,
    allowInlineLaunchesForTesting: true,
  });
  expect(await engine.start(startCommand)).toEqual(await engine.start(startCommand));
  await engine.tick();
  const occurrence = database
    .query<{ agent_run_id: string }, []>("SELECT agent_run_id FROM workflow_step_occurrences")
    .get();
  const revision = engine.inspect("workflow_1");
  if (!revision.ok) throw new Error("MISSING_TEST_WORKFLOW");
  const event = {
    eventId: "terminal_1",
    actor: startCommand.schedulerActor,
    workflowExecutionId: "workflow_1",
    expectedRevision: revision.value.revision,
    stepOccurrenceId: "implement-1",
    runId: occurrence?.agent_run_id ?? "missing",
    result: {
      stepOccurrenceId: "implement-1",
      runId: occurrence?.agent_run_id ?? "missing",
      key: "READY_FOR_REVIEW",
      artifacts: [],
    },
  } as const;
  await engine.accept(event);
  await engine.accept(event);
  await engine.tick();
  expect(fake.commands).toHaveLength(2);
  database.close();
});

test("a contract-invalid result leaves the durable occurrence active", async () => {
  const database = new Database(":memory:", { strict: true });
  database.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  for (let version = 1; version <= 12; version += 1)
    database.query("INSERT INTO schema_migrations VALUES (?, 0)").run(version);
  database.exec(migration13);
  database.exec(migration14);
  const fake = createWorkflowAuthority();
  const engine = createWorkflowEngine({
    database,
    authority: fake.authority,
    clock: () => 100,
    allowInlineLaunchesForTesting: true,
  });
  await engine.start(startCommand);
  await engine.tick();
  const runId = database
    .query<{ agent_run_id: string }, []>("SELECT agent_run_id FROM workflow_step_occurrences")
    .get()?.agent_run_id;
  if (!runId) throw new Error("MISSING_TEST_RUN");
  const revision = engine.inspect("workflow_1");
  if (!revision.ok) throw new Error("MISSING_TEST_WORKFLOW");
  expect(
    await engine.accept({
      eventId: "invalid_terminal",
      actor: startCommand.schedulerActor,
      workflowExecutionId: "workflow_1",
      expectedRevision: revision.value.revision,
      stepOccurrenceId: "implement-1",
      runId,
      result: { stepOccurrenceId: "implement-1", runId, key: "PROSE_DERIVED", artifacts: [] },
    }),
  ).toMatchObject({ ok: false, error: { code: "WORKFLOW_RESULT_CONTRACT_VIOLATION" } });
  expect(
    database.query<{ state: string }, []>("SELECT state FROM workflow_step_occurrences").get()
      ?.state,
  ).toBe("RUNNING");
  expect(
    database
      .query<{ count: number }, []>("SELECT count(*) AS count FROM workflow_event_receipts")
      .get()?.count,
  ).toBe(0);
  database.close();
});
