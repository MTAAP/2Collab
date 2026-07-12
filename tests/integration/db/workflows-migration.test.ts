import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import migration from "../../../src/server/db/migrations/0013_workflows.sql" with { type: "text" };
import { verifyWorkflowsSchema } from "../../../src/server/db/migrations/0013_workflows.verify.ts";

test("migration 0013 creates the strict workflow authoring schema", () => {
  const database = new Database(":memory:", { strict: true });
  database.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  for (let version = 1; version <= 12; version += 1)
    database.query("INSERT INTO schema_migrations VALUES (?, 0)").run(version);
  database.exec(migration);
  expect(() => verifyWorkflowsSchema(database)).not.toThrow();
  database.close();
});
