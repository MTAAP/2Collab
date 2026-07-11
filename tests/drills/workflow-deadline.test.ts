import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import migration13 from "../../src/server/db/migrations/0013_workflows.sql" with { type: "text" };
import migration14 from "../../src/server/db/migrations/0014_workflow_execution.sql" with {
  type: "text",
};
import type { MemberId, SessionId } from "../../src/shared/contracts/ids.ts";
import { createWorkflowEngine } from "../../src/server/modules/workflows/workflow-engine.ts";
import { createWorkflowAuthority, startCommand } from "../fixtures/workflows/engine.ts";

test("pause and restart never extend the absolute deadline", async () => {
  const database = new Database(":memory:", { strict: true });
  database.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  for (let version = 1; version <= 12; version += 1)
    database.query("INSERT INTO schema_migrations VALUES (?, 0)").run(version);
  database.exec(migration13);
  database.exec(migration14);
  let now = 100;
  const fake = createWorkflowAuthority();
  const engine = createWorkflowEngine({
    database,
    authority: fake.authority,
    clock: () => now,
    allowInlineLaunchesForTesting: true,
  });
  const started = await engine.start(startCommand);
  if (!started.ok) throw new Error("MISSING_TEST_WORKFLOW");
  const actor = {
    kind: "MEMBER" as const,
    memberId: "member_1" as MemberId,
    sessionId: "session_1" as SessionId,
    sessionProof: "x".repeat(32),
  };
  await engine.pause({
    idempotencyKey: "pause_1",
    actor,
    workflowExecutionId: "workflow_1",
    expectedRevision: started.value.revision,
  });
  now = started.value.absoluteDeadlineAt;
  const restarted = createWorkflowEngine({
    database,
    authority: fake.authority,
    clock: () => now,
    allowInlineLaunchesForTesting: true,
  });
  await restarted.tick();
  expect(restarted.inspect("workflow_1")).toMatchObject({
    ok: true,
    value: { state: "FAILED", terminalReason: "WORKFLOW_DEADLINE_EXCEEDED" },
  });
  expect(
    await restarted.resume({
      idempotencyKey: "resume_1",
      actor,
      workflowExecutionId: "workflow_1",
      expectedRevision: 3,
    }),
  ).toMatchObject({ ok: false, error: { code: "WORKFLOW_TERMINAL" } });
  database.close();
});

test("results arriving while paused do not launch the next step until resume", async () => {
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
  const actor = {
    kind: "MEMBER" as const,
    memberId: "member_1" as MemberId,
    sessionId: "session_1" as SessionId,
    sessionProof: "x".repeat(32),
  };
  const running = engine.inspect("workflow_1");
  if (!running.ok) throw new Error("MISSING_TEST_WORKFLOW");
  const paused = await engine.pause({
    idempotencyKey: "pause_running",
    actor,
    workflowExecutionId: "workflow_1",
    expectedRevision: running.value.revision,
  });
  if (!paused.ok) throw new Error("MISSING_PAUSED_WORKFLOW");
  const runId = database
    .query<{ agent_run_id: string }, []>(
      "SELECT agent_run_id FROM workflow_step_occurrences WHERE id = 'implement-1'",
    )
    .get()?.agent_run_id;
  if (!runId) throw new Error("MISSING_TEST_RUN");
  const accepted = await engine.accept({
    eventId: "paused_result",
    actor: startCommand.schedulerActor,
    workflowExecutionId: "workflow_1",
    expectedRevision: paused.value.revision,
    stepOccurrenceId: "implement-1",
    runId,
    result: { stepOccurrenceId: "implement-1", runId, key: "READY_FOR_REVIEW", artifacts: [] },
  });
  if (!accepted.ok) throw new Error("MISSING_ACCEPTED_RESULT");
  await engine.tick();
  expect(fake.commands).toHaveLength(1);
  await engine.resume({
    idempotencyKey: "resume_running",
    actor,
    workflowExecutionId: "workflow_1",
    expectedRevision: accepted.value.revision,
  });
  await engine.tick();
  expect(fake.commands).toHaveLength(2);
  database.close();
});
