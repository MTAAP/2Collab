import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import migration13 from "../../../src/server/db/migrations/0013_workflows.sql" with {
  type: "text",
};
import migration14 from "../../../src/server/db/migrations/0014_workflow_execution.sql" with {
  type: "text",
};
import { createWorkflowEngine } from "../../../src/server/modules/workflows/workflow-engine.ts";
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

test("starts one durable child step only through ExecutionAuthority", async () => {
  const fake = createWorkflowAuthority();
  const engine = createWorkflowEngine({ database, authority: fake.authority, clock: () => 100 });
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

test("the absolute deadline continues before dispatch and through restart", async () => {
  let now = 100;
  const fake = createWorkflowAuthority();
  const engine = createWorkflowEngine({ database, authority: fake.authority, clock: () => now });
  await engine.start(startCommand);
  now += startCommand.definition.absoluteDeadlineMs;
  const restarted = createWorkflowEngine({ database, authority: fake.authority, clock: () => now });
  await restarted.tick();
  expect(restarted.inspect("workflow_1")).toMatchObject({
    ok: true,
    value: { state: "FAILED", terminalReason: "WORKFLOW_DEADLINE_EXCEEDED" },
  });
  expect(fake.commands).toHaveLength(0);
});
