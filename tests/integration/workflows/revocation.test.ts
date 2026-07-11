import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import migration13 from "../../../src/server/db/migrations/0013_workflows.sql" with {
  type: "text",
};
import migration14 from "../../../src/server/db/migrations/0014_workflow_execution.sql" with {
  type: "text",
};
import { createWorkflowEngine } from "../../../src/server/modules/workflows/workflow-engine.ts";
import { applyWorkflowRevocation } from "../../../src/server/modules/workflows/revocation.ts";
import { createWorkflowAuthority, startCommand } from "../../fixtures/workflows/engine.ts";

test("revocation invalidates affected future work and retains unaffected active work", () => {
  const calls: unknown[] = [];
  const event = { kind: "MEMBER", subjectId: "member_1", epoch: 2 } as const;
  applyWorkflowRevocation(
    {
      invalidateAffectedLaunchIntents: (value) => calls.push(["INVALIDATE", value]),
      moveRequiredAffectedWorkflowsToWaiting: (value, reason) =>
        calls.push(["WAIT", value, reason]),
      retainUnaffectedActiveWork: () => calls.push(["RETAIN"]),
    },
    event,
  );
  expect(calls).toEqual([
    ["INVALIDATE", event],
    ["WAIT", event, "WORKFLOW_AUTHORITY_REVOKED"],
    ["RETAIN"],
  ]);
});

test("Foundation member revocation durably waits and cancels active child runs", async () => {
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
    clockMs: () => 100,
    allowInlineLaunchesForTesting: true,
  });
  await engine.start(startCommand);
  await engine.tick();
  expect(engine.applyRevocation({ kind: "MEMBER", subjectId: "member_1", epoch: 2 })).toMatchObject(
    [{ state: "WAITING", terminalReason: "WORKFLOW_AUTHORITY_REVOKED" }],
  );
  expect(
    database
      .query<{ count: number }, []>("SELECT count(*) AS count FROM workflow_cancellation_outbox")
      .get()?.count,
  ).toBe(1);
  database.close();
});
