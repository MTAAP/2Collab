import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import migration15 from "../../../src/server/db/migrations/0015_gates_telemetry.sql" with {
  type: "text",
};
import {
  advanceManagedLoop,
  createManagedLoopStore,
} from "../../../src/server/modules/workflows/managed-loops.ts";

test("failed starts and lost attempts consume the same immutable maximum", () => {
  const base = {
    attemptsCreated: 0,
    maximumAttempts: 2,
    absoluteDeadlineAt: 1_000,
    consecutiveState: { matches: 0 },
  };
  const failed = advanceManagedLoop(base, { kind: "FAILED_TO_START", observedAt: 100 });
  if (!failed.ok) throw new Error("EXPECTED_FAILED_START_ACCOUNTING");
  const lost = advanceManagedLoop(failed.value, { kind: "LOST", observedAt: 200 });
  if (!lost.ok) throw new Error("EXPECTED_LOST_ATTEMPT_ACCOUNTING");
  expect(lost.value.attemptsCreated).toBe(2);
  expect(advanceManagedLoop(lost.value, { kind: "REQUEST_NEXT", observedAt: 300 })).toMatchObject({
    ok: false,
    error: { code: "ATTEMPT_BUDGET_EXHAUSTED" },
  });
});

test("durable counters survive a store restart", () => {
  const database = new Database(":memory:", { strict: true });
  database.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  for (let version = 1; version <= 14; version += 1)
    database.query("INSERT INTO schema_migrations VALUES (?, 0)").run(version);
  database.exec(migration15);
  const initial = {
    attemptsCreated: 0,
    maximumAttempts: 2,
    absoluteDeadlineAt: 1_000,
    consecutiveState: { matches: 0 },
  };
  createManagedLoopStore(database).create(
    "run_1",
    { kind: "AGENT_OUTCOME", value: "GOAL_ACHIEVED" },
    initial,
  );
  createManagedLoopStore(database).record("run_1", { kind: "FAILED_TO_START", observedAt: 100 });
  expect(createManagedLoopStore(database).read("run_1")).toMatchObject({ attemptsCreated: 1 });
  database.close();
});

test("attempt event identity prevents duplicate budget consumption", () => {
  const database = new Database(":memory:", { strict: true });
  database.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  for (let version = 1; version <= 14; version += 1)
    database.query("INSERT INTO schema_migrations VALUES (?, 0)").run(version);
  database.exec(migration15);
  const store = createManagedLoopStore(database);
  store.create(
    "run_1",
    { kind: "AGENT_OUTCOME", value: "GOAL_ACHIEVED" },
    {
      attemptsCreated: 0,
      maximumAttempts: 2,
      absoluteDeadlineAt: 1_000,
      consecutiveState: { matches: 0 },
    },
  );
  const event = {
    eventId: "event_attempt_1",
    attemptId: "attempt_1",
    kind: "FAILED_TO_START" as const,
    observedAt: 100,
  };
  expect(store.record("run_1", event)).toMatchObject({
    ok: true,
    value: { attemptsCreated: 1 },
  });
  expect(store.record("run_1", event)).toMatchObject({
    ok: true,
    value: { attemptsCreated: 1 },
  });
  expect(store.record("run_1", { ...event, kind: "LOST" })).toMatchObject({
    ok: false,
    error: { code: "MANAGED_LOOP_EVENT_CONFLICT" },
  });
  database.close();
});

test("three-valued policy evaluation is durable and idempotent", () => {
  const database = new Database(":memory:", { strict: true });
  database.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  for (let version = 1; version <= 14; version += 1)
    database.query("INSERT INTO schema_migrations VALUES (?, 0)").run(version);
  database.exec(migration15);
  const store = createManagedLoopStore(database);
  store.create(
    "run_1",
    {
      kind: "CONSECUTIVE_MATCHES",
      condition: { kind: "SOURCE", predicate: { kind: "GITHUB_CHECK", key: "checks" } },
      count: 2,
    },
    {
      attemptsCreated: 0,
      maximumAttempts: 3,
      absoluteDeadlineAt: 1_000,
      consecutiveState: { matches: 0 },
    },
  );
  const facts = { source: { checks: "TRUE" as const } };
  expect(store.evaluate("run_1", "evaluation_1", facts, 100)).toMatchObject({
    ok: true,
    value: { result: "FALSE", state: { matches: 1 } },
  });
  expect(store.evaluate("run_1", "evaluation_1", facts, 100)).toMatchObject({
    ok: true,
    value: { result: "FALSE", state: { matches: 1 } },
  });
  expect(
    store.evaluate("run_1", "evaluation_2", { source: { checks: "UNKNOWN" } }, 200),
  ).toMatchObject({ ok: true, value: { result: "UNKNOWN", state: { matches: 1 } } });
  database.close();
});

test("the loop deadline cannot be disabled or extended", () => {
  const state = {
    attemptsCreated: 0,
    maximumAttempts: 3,
    absoluteDeadlineAt: 500,
    consecutiveState: { matches: 0 },
  };
  expect(advanceManagedLoop(state, { kind: "REQUEST_NEXT", observedAt: 500 })).toMatchObject({
    ok: false,
    error: { code: "WORKFLOW_DEADLINE_EXCEEDED" },
  });
});
