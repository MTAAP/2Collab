import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import migration13 from "../../../src/server/db/migrations/0013_workflows.sql" with {
  type: "text",
};
import migration14 from "../../../src/server/db/migrations/0014_workflow_execution.sql" with {
  type: "text",
};
import { verifyWorkflowExecutionSchema } from "../../../src/server/db/migrations/0014_workflow_execution.verify.ts";

test("migration 0014 creates strict durable workflow execution state", () => {
  const database = new Database(":memory:", { strict: true });
  database.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  for (let version = 1; version <= 12; version += 1)
    database.query("INSERT INTO schema_migrations VALUES (?, 0)").run(version);
  database.exec(migration13);
  database.exec(migration14);
  expect(() => verifyWorkflowExecutionSchema(database)).not.toThrow();
  database.close();
});
