import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import migration15 from "../../../src/server/db/migrations/0015_gates_telemetry.sql" with {
  type: "text",
};
import {
  aggregateWorkflowUsage,
  createWorkflowUsageStore,
} from "../../../src/server/modules/telemetry/workflow-usage.ts";

test("workflow aggregation remains a projection over immutable attempts and gates", () => {
  const attempts = Object.freeze([
    Object.freeze({ inputUnits: 10, outputUnits: 5, runtimeMs: 100, category: "TOKENS" as const }),
  ]);
  const gates = Object.freeze([Object.freeze({ durationMs: 20 })]);
  expect(aggregateWorkflowUsage(attempts, gates)).toMatchObject({
    coverage: { status: "COMPLETE" },
    runtimeMs: 100,
    gateMs: 20,
  });
  expect(attempts[0]).toEqual({
    inputUnits: 10,
    outputUnits: 5,
    runtimeMs: 100,
    category: "TOKENS",
  });
});

test("persists an immutable usage snapshot keyed by workflow revision", () => {
  const database = new Database(":memory:", { strict: true });
  database.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  for (let version = 1; version <= 14; version += 1)
    database.query("INSERT INTO schema_migrations VALUES (?, 0)").run(version);
  database.exec(migration15);
  const usage = createWorkflowUsageStore({ database, clock: () => 100 }).record(
    "workflow_1",
    3,
    [
      { inputUnits: 10, outputUnits: 5, runtimeMs: 100, category: "TOKENS" },
      { inputUnits: "UNKNOWN", outputUnits: "UNKNOWN", runtimeMs: 50, category: "TOKENS" },
    ],
    [{ durationMs: 20 }],
  );
  expect(usage).toMatchObject({ coverage: { status: "PARTIAL" }, runtimeMs: 150, gateMs: 20 });
  expect(
    database
      .query<{ coverage_status: string; known_attempts: number; total_attempts: number }, []>(
        "SELECT coverage_status, known_attempts, total_attempts FROM workflow_usage_snapshots",
      )
      .get(),
  ).toEqual({ coverage_status: "PARTIAL", known_attempts: 1, total_attempts: 2 });
  database.close();
});
