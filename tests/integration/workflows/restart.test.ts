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

test("a committed launch intent creates one child run after restart", async () => {
  const database = new Database(":memory:", { strict: true });
  database.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  for (let version = 1; version <= 12; version += 1)
    database.query("INSERT INTO schema_migrations VALUES (?, 0)").run(version);
  database.exec(migration13);
  database.exec(migration14);
  const fake = createWorkflowAuthority();
  const engine = createWorkflowEngine({ database, authority: fake.authority, clock: () => 100 });
  await engine.start(startCommand);
  engine.failAfterIntentCommitOnce();
  await expect(engine.tick()).rejects.toThrow("INJECTED_WORKFLOW_SCHEDULER_CRASH");
  const restarted = createWorkflowEngine({ database, authority: fake.authority, clock: () => 100 });
  await restarted.tick();
  await restarted.tick();
  expect(fake.commands).toHaveLength(1);
  database.close();
});
