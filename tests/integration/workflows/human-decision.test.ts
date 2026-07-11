import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import migration13 from "../../../src/server/db/migrations/0013_workflows.sql" with {
  type: "text",
};
import migration14 from "../../../src/server/db/migrations/0014_workflow_execution.sql" with {
  type: "text",
};
import type { MemberId, SessionId } from "../../../src/shared/contracts/ids.ts";
import type { StartWorkflow } from "../../../src/server/modules/workflows/contract.ts";
import { createWorkflowEngine } from "../../../src/server/modules/workflows/workflow-engine.ts";
import { createWorkflowAuthority, startCommand } from "../../fixtures/workflows/engine.ts";

test("a durable decision survives restart and schedules its choice once", async () => {
  const database = new Database(":memory:", { strict: true });
  database.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  for (let version = 1; version <= 12; version += 1)
    database.query("INSERT INTO schema_migrations VALUES (?, 0)").run(version);
  database.exec(migration13);
  database.exec(migration14);
  const fake = createWorkflowAuthority();
  const definition = {
    ...startCommand.definition,
    nodes: [
      { kind: "START" as const, key: "start" },
      { kind: "HUMAN_DECISION" as const, key: "approval", choices: ["APPROVE", "REJECT"] },
      {
        kind: "AGENT_RUN" as const,
        key: "implement",
        runTemplateVersionId: "run_template_implement_v1",
        resultKeys: ["READY_FOR_REVIEW"],
      },
      { kind: "TERMINAL" as const, key: "rejected", outcome: "CANCELLED" as const },
    ],
    transitions: [
      { from: "start", resultKey: "STARTED", to: "approval" },
      { from: "approval", resultKey: "APPROVE", to: "implement" },
      { from: "approval", resultKey: "REJECT", to: "rejected" },
    ],
    maximumRunCount: 1,
    cycleBounds: {},
  };
  const command = {
    ...startCommand,
    workflowExecutionId: "workflow_decision",
    schedulerActor: {
      ...startCommand.schedulerActor,
      workflowExecutionId: "workflow_decision" as never,
    },
    idempotencyKey: "decision_start",
    definition,
  } as StartWorkflow;
  const engine = createWorkflowEngine({
    database,
    authority: fake.authority,
    clock: () => 100,
    allowInlineLaunchesForTesting: true,
  });
  expect(await engine.start(command)).toMatchObject({ ok: true, value: { state: "WAITING" } });
  expect(fake.commands).toHaveLength(0);
  const restarted = createWorkflowEngine({
    database,
    authority: fake.authority,
    clock: () => 100,
    allowInlineLaunchesForTesting: true,
  });
  const decision = {
    workflowExecutionId: "workflow_decision",
    nodeKey: "approval",
    choice: "APPROVE",
    actor: {
      kind: "MEMBER",
      memberId: "member_1" as MemberId,
      sessionId: "session_1" as SessionId,
      sessionProof: "x".repeat(32),
    },
    expectedRevision: 1,
    decisionId: "decision_1",
  } as const;
  await restarted.decide(decision);
  await restarted.decide(decision);
  await restarted.tick();
  expect(fake.commands).toHaveLength(1);
  database.close();
});
