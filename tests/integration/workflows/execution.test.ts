import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import migration13 from "../../../src/server/db/migrations/0013_workflows.sql" with {
  type: "text",
};
import migration14 from "../../../src/server/db/migrations/0014_workflow_execution.sql" with {
  type: "text",
};
import { createWorkflowEngine } from "../../../src/server/modules/workflows/workflow-engine.ts";
import type { WorkflowEventCommand } from "../../../src/server/modules/workflows/contract.ts";
import type { ExecutionAuthority } from "../../../src/shared/contracts/execution-authority.ts";
import { createWorkflowAuthority, startCommand } from "../../fixtures/workflows/engine.ts";

let database: Database;
beforeEach(() => {
  database = new Database(":memory:", { strict: true });
  database.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  for (let version = 1; version <= 12; version += 1)
    database.query("INSERT INTO schema_migrations VALUES (?, 0)").run(version);
  database.exec(migration13);
  database.exec(migration14);
});
afterEach(() => database.close());

function deferredLaunchAuthority() {
  const fake = createWorkflowAuthority();
  const execute = fake.authority.execute.bind(fake.authority);
  let releaseLaunch = () => {};
  const launchBlocked = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });
  let launchStarted = () => {};
  const launchObserved = new Promise<void>((resolve) => {
    launchStarted = resolve;
  });
  const authority = {
    preview: fake.authority.preview.bind(fake.authority),
    query: fake.authority.query.bind(fake.authority),
    execute: async (command: Parameters<ExecutionAuthority["execute"]>[0]) => {
      if (command.kind === "LAUNCH_RUN") {
        launchStarted();
        await launchBlocked;
      }
      return execute(command as never);
    },
  } as ExecutionAuthority;
  return { ...fake, authority, launchObserved, releaseLaunch };
}

test("starts one durable child step only through ExecutionAuthority", async () => {
  const fake = createWorkflowAuthority();
  const engine = createWorkflowEngine({
    database,
    authority: fake.authority,
    clockMs: () => 100,
    allowInlineLaunchesForTesting: true,
  });
  expect(await engine.start(startCommand)).toMatchObject({
    ok: true,
    value: { id: "workflow_1", state: "ACTIVE", revision: 1 },
  });
  expect(fake.commands).toHaveLength(0);
  await engine.tick();
  expect(fake.commands).toHaveLength(1);
  expect(fake.commands[0]).toMatchObject({
    kind: "LAUNCH_RUN",
    actor: { kind: "SCHEDULER" },
    workflow: { workflowExecutionId: "workflow_1", stepOccurrenceId: "implement-1" },
  });
});

test("production engine rejects caller-supplied definitions and launch snapshots", async () => {
  const fake = createWorkflowAuthority();
  const engine = createWorkflowEngine({ database, authority: fake.authority, clockMs: () => 100 });
  expect(await engine.start(startCommand)).toMatchObject({
    ok: false,
    error: { code: "WORKFLOW_STORED_LAUNCH_REQUIRED" },
  });
  expect(fake.commands).toHaveLength(0);
});

test("loads immutable template and exact preset bindings and snapshots typed inputs server-side", async () => {
  const runTemplate = (resultKeys: readonly string[], mode: "MUTATING" | "INSPECT_ONLY") =>
    JSON.stringify({
      name: "Step",
      coreInstructions: "Perform the step.",
      variables: [],
      resultKeys,
      repositoryMode: mode,
      minimumAssurance: "ADVISORY",
      gateSets: [],
      maximumAttempts: 1,
      absoluteDeadlineMs: 60_000,
    });
  database
    .query(
      `INSERT INTO team_run_template_versions(
         id, template_key, version, project_id, definition_json, semantic_hash,
         published_by_member_id, published_at
       ) VALUES (?, ?, 1, NULL, ?, ?, 'member_1', 100)`,
    )
    .run(
      "run_template_implement_v1",
      "implement",
      runTemplate(["READY_FOR_REVIEW"], "MUTATING"),
      "a".repeat(64),
    );
  database
    .query(
      `INSERT INTO team_run_template_versions(
         id, template_key, version, project_id, definition_json, semantic_hash,
         published_by_member_id, published_at
       ) VALUES (?, ?, 1, NULL, ?, ?, 'member_1', 100)`,
    )
    .run(
      "run_template_review_v1",
      "review",
      runTemplate(["APPROVED", "CHANGES_REQUESTED"], "INSPECT_ONLY"),
      "b".repeat(64),
    );
  database
    .query(
      `INSERT INTO team_workflow_template_versions(
         id, template_key, version, definition_json, semantic_hash,
         published_by_member_id, published_at
       ) VALUES ('workflow_template_1', 'workflow', 1, ?, ?, 'member_1', 100)`,
    )
    .run(JSON.stringify(startCommand.definition), "c".repeat(64));
  const bindings = {
    implement: { personalRunPresetId: "implement_preset", expectedVersion: 1 },
    review: { personalRunPresetId: "review_preset", expectedVersion: 2 },
  };
  database
    .query(
      `INSERT INTO personal_workflow_presets(
         id, owner_member_id, version, workflow_template_version_id, bindings_json, created_at
       ) VALUES ('workflow_preset_1', 'member_1', 1, 'workflow_template_1', ?, 100)`,
    )
    .run(JSON.stringify(bindings));
  const fake = createWorkflowAuthority();
  const resolutions: unknown[] = [];
  const engine = createWorkflowEngine({
    database,
    authority: fake.authority,
    clockMs: () => 100,
    allowInlineLaunchesForTesting: true,
    resolveLaunches: async (input) => {
      resolutions.push(input);
      return { ok: true, value: startCommand.launches };
    },
  });
  const result = await engine.start({
    idempotencyKey: "workflow_stored_start",
    workflowExecutionId: "workflow_stored",
    coordinationRecordId: "coordination_1" as never,
    coordinationRevision: 1,
    templateVersionId: "workflow_template_1",
    presetVersionId: "workflow_preset_1_v1",
    workflowPresetId: "workflow_preset_1",
    workflowPresetVersion: 1,
    inputs: { goal: "Ship safely" },
    schedulerActor: {
      ...startCommand.schedulerActor,
      workflowExecutionId: "workflow_stored" as never,
    },
  });
  expect(result).toMatchObject({ ok: true, value: { id: "workflow_stored" } });
  expect(resolutions).toMatchObject([{ inputs: { goal: "Ship safely" }, bindings }]);
  const stored = JSON.parse(
    database
      .query<{ snapshot_json: string }, [string]>(
        "SELECT snapshot_json FROM workflow_executions WHERE id = ?",
      )
      .get("workflow_stored")?.snapshot_json ?? "null",
  );
  expect(stored).toMatchObject({ inputs: { goal: "Ship safely" }, presetBindings: bindings });
});

test("the absolute deadline continues before dispatch and through restart", async () => {
  let now = 100;
  const fake = createWorkflowAuthority();
  const engine = createWorkflowEngine({
    database,
    authority: fake.authority,
    clockMs: () => now,
    allowInlineLaunchesForTesting: true,
  });
  await engine.start(startCommand);
  now += startCommand.definition.absoluteDeadlineMs;
  const restarted = createWorkflowEngine({
    database,
    authority: fake.authority,
    clockMs: () => now,
    allowInlineLaunchesForTesting: true,
  });
  await restarted.tick();
  expect(restarted.inspect("workflow_1")).toMatchObject({
    ok: true,
    value: { state: "FAILED", terminalReason: "WORKFLOW_DEADLINE_EXCEEDED" },
  });
  expect(fake.commands).toHaveLength(0);
});

test("absoluteDeadlineMs expires at exactly 60,000 milliseconds, not 60 seconds of clock ticks", async () => {
  const startedAtMs = 1_700_000_000_000;
  let nowMs = startedAtMs;
  const fake = createWorkflowAuthority();
  const engine = createWorkflowEngine({
    database,
    authority: fake.authority,
    clockMs: () => nowMs,
    allowInlineLaunchesForTesting: true,
  });
  const started = await engine.start({
    ...startCommand,
    definition: { ...startCommand.definition, absoluteDeadlineMs: 60_000 },
  });
  if (!started.ok) throw new Error("EXPECTED_WORKFLOW_START");
  expect(started.value.absoluteDeadlineAt).toBe(startedAtMs + 60_000);

  nowMs = startedAtMs + 59_999;
  await engine.tick();
  expect(engine.inspect(started.value.id)).toMatchObject({ ok: true, value: { state: "ACTIVE" } });

  nowMs = startedAtMs + 60_000;
  await engine.tick();
  expect(engine.inspect(started.value.id)).toMatchObject({
    ok: true,
    value: { state: "FAILED", terminalReason: "WORKFLOW_DEADLINE_EXCEEDED" },
  });
});

test("durable cancel invalidates future launches and enqueues active child cancellation", async () => {
  const fake = createWorkflowAuthority();
  const engine = createWorkflowEngine({
    database,
    authority: fake.authority,
    clockMs: () => 100,
    allowInlineLaunchesForTesting: true,
  });
  const started = await engine.start(startCommand);
  if (!started.ok) throw new Error("EXPECTED_WORKFLOW_START");
  await engine.tick();

  const cancelled = await engine.cancel({
    idempotencyKey: "cancel_workflow_1",
    workflowExecutionId: "workflow_1",
    expectedRevision: 2,
    actor: {
      kind: "MEMBER",
      memberId: "member_1" as never,
      sessionId: "session_1" as never,
      sessionProof: "x".repeat(32),
    },
  });

  expect(cancelled).toMatchObject({
    ok: true,
    value: { state: "CANCELLED", terminalReason: "WORKFLOW_CANCELLED", revision: 3 },
  });
  expect(
    database
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM workflow_cancellation_outbox WHERE requested_at IS NULL",
      )
      .get()?.count,
  ).toBe(1);
});

test("deadline expiry enqueues cancellation for a running child", async () => {
  let now = 100;
  const fake = createWorkflowAuthority();
  const engine = createWorkflowEngine({
    database,
    authority: fake.authority,
    clockMs: () => now,
    allowInlineLaunchesForTesting: true,
  });
  await engine.start(startCommand);
  await engine.tick();
  now += startCommand.definition.absoluteDeadlineMs;
  await engine.tick();
  expect(engine.inspect("workflow_1")).toMatchObject({
    ok: true,
    value: { state: "FAILED", terminalReason: "WORKFLOW_DEADLINE_EXCEEDED" },
  });
  expect(
    database
      .query<{ count: number }, []>("SELECT count(*) AS count FROM workflow_cancellation_outbox")
      .get()?.count,
  ).toBe(1);
});

test.each([
  {
    invalidation: "CANCEL" as const,
    expectedState: "CANCELLED",
    expectedReason: "WORKFLOW_CANCELLED",
  },
  {
    invalidation: "DEADLINE" as const,
    expectedState: "FAILED",
    expectedReason: "WORKFLOW_DEADLINE_EXCEEDED",
  },
  {
    invalidation: "REVOCATION" as const,
    expectedState: "WAITING",
    expectedReason: "WORKFLOW_AUTHORITY_REVOKED",
  },
])("records and cancellation-enqueues a child launched concurrently with $invalidation invalidation", async ({
  invalidation,
  expectedState,
  expectedReason,
}) => {
  let now = 1_000;
  const fake = deferredLaunchAuthority();
  const engine = createWorkflowEngine({
    database,
    authority: fake.authority,
    clockMs: () => now,
    allowInlineLaunchesForTesting: true,
  });
  const started = await engine.start(startCommand);
  if (!started.ok) throw new Error("EXPECTED_WORKFLOW_START");

  const dispatch = engine.tick();
  await fake.launchObserved;
  if (invalidation === "CANCEL") {
    await engine.cancel({
      idempotencyKey: "cancel_during_launch",
      workflowExecutionId: started.value.id,
      expectedRevision: started.value.revision,
      actor: {
        kind: "MEMBER",
        memberId: "member_1" as never,
        sessionId: "session_1" as never,
        sessionProof: "x".repeat(32),
      },
    });
  } else if (invalidation === "DEADLINE") {
    now = started.value.absoluteDeadlineAt;
    await createWorkflowEngine({
      database,
      authority: fake.authority,
      clockMs: () => now,
      allowInlineLaunchesForTesting: true,
    }).tick();
  } else {
    engine.applyRevocation({ kind: "MEMBER", subjectId: "member_1", epoch: 2 });
  }
  fake.releaseLaunch();
  await dispatch;

  expect(engine.inspect(started.value.id)).toMatchObject({
    ok: true,
    value: { state: expectedState, terminalReason: expectedReason },
  });
  expect(
    database
      .query<{ state: string; agent_run_id: string | null }, []>(
        "SELECT state, agent_run_id FROM workflow_step_occurrences WHERE id = 'implement-1'",
      )
      .get(),
  ).toMatchObject({ state: "CANCELLED", agent_run_id: "run_1" });
  expect(
    database
      .query<{ agent_run_id: string }, []>(
        "SELECT agent_run_id FROM workflow_cancellation_outbox WHERE step_occurrence_id = 'implement-1'",
      )
      .get(),
  ).toEqual({ agent_run_id: "run_1" });
});

test("declared cycle bounds are durable runtime limits across restart and event replay", async () => {
  const fake = createWorkflowAuthority();
  const boundedCommand = {
    ...startCommand,
    definition: {
      ...startCommand.definition,
      cycleBounds: { "implement->review->review_result": 1 },
    },
  };
  let engine = createWorkflowEngine({
    database,
    authority: fake.authority,
    clockMs: () => 1_000,
    allowInlineLaunchesForTesting: true,
  });
  const started = await engine.start(boundedCommand);
  if (!started.ok) throw new Error("EXPECTED_WORKFLOW_START");

  let replayCommand: WorkflowEventCommand | undefined;
  const complete = async (nodeKey: string, resultKey: string, eventId: string) => {
    const occurrence = database
      .query<{ id: string; agent_run_id: string }, [string]>(
        `SELECT id, agent_run_id FROM workflow_step_occurrences
         WHERE workflow_execution_id = 'workflow_1' AND node_key = ?
         ORDER BY occurrence DESC LIMIT 1`,
      )
      .get(nodeKey);
    const execution = engine.inspect("workflow_1");
    if (!occurrence || !execution.ok) throw new Error("EXPECTED_RUNNING_OCCURRENCE");
    const command: WorkflowEventCommand = {
      eventId,
      actor: startCommand.schedulerActor,
      workflowExecutionId: "workflow_1",
      expectedRevision: execution.value.revision,
      stepOccurrenceId: occurrence.id,
      runId: occurrence.agent_run_id,
      result: {
        stepOccurrenceId: occurrence.id,
        runId: occurrence.agent_run_id,
        key: resultKey,
        artifacts: [],
      },
    };
    if (eventId === "review_2_done") replayCommand = command;
    return engine.accept(command);
  };

  await engine.tick();
  await complete("implement", "READY_FOR_REVIEW", "implement_1_done");
  await engine.tick();
  await complete("review", "CHANGES_REQUESTED", "review_1_done");
  await engine.tick();
  await complete("implement", "READY_FOR_REVIEW", "implement_2_done");
  await engine.tick();
  const exceeded = await complete("review", "CHANGES_REQUESTED", "review_2_done");
  expect(exceeded).toMatchObject({
    ok: true,
    value: { state: "FAILED", terminalReason: "WORKFLOW_CYCLE_BOUND_EXCEEDED" },
  });
  expect(
    database
      .query<{ completed_count: number }, []>(
        `SELECT completed_count FROM workflow_cycle_counters
         WHERE workflow_execution_id = 'workflow_1'
           AND cycle_signature = 'implement->review->review_result'`,
      )
      .get(),
  ).toEqual({ completed_count: 2 });

  engine = createWorkflowEngine({
    database,
    authority: fake.authority,
    clockMs: () => 1_000,
    allowInlineLaunchesForTesting: true,
  });
  if (!replayCommand) throw new Error("EXPECTED_REPLAY_COMMAND");
  expect(await engine.accept(replayCommand)).toMatchObject({
    ok: true,
    value: { state: "FAILED", terminalReason: "WORKFLOW_CYCLE_BOUND_EXCEEDED" },
  });
  await engine.tick();
  expect(
    database
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM workflow_step_occurrences WHERE node_key = 'implement'",
      )
      .get()?.count,
  ).toBe(2);
});
