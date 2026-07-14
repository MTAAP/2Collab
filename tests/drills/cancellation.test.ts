import { expect, test } from "bun:test";
import {
  createRunReconciler,
  decideCancellationReconciliation,
} from "../../src/server/modules/runs/reconciliation.ts";
import type { ExecutionAuthority } from "../../src/shared/contracts/execution-authority.ts";

test("cancellation distinguishes requested, confirmed, unreachable, and lost", () => {
  expect(
    decideCancellationReconciliation({
      now: 100,
      requestedAt: 100,
      lostAt: 190,
      processState: "NOT_STARTED",
    }),
  ).toEqual({ action: "CONFIRM_CANCELLED", confirmation: "PROCESS_NOT_STARTED" });
  expect(
    decideCancellationReconciliation({
      now: 101,
      requestedAt: 100,
      lostAt: 190,
      processState: "TERMINATED",
    }),
  ).toEqual({ action: "CONFIRM_CANCELLED", confirmation: "PROCESS_TERMINATED" });
  expect(
    decideCancellationReconciliation({
      now: 189,
      requestedAt: 100,
      lostAt: 190,
      processState: "UNREACHABLE",
    }),
  ).toEqual({ action: "AWAIT_RECONCILIATION" });
  expect(
    decideCancellationReconciliation({
      now: 190,
      requestedAt: 100,
      lostAt: 190,
      processState: "UNREACHABLE",
    }),
  ).toEqual({ action: "MARK_LOST" });
  expect(
    decideCancellationReconciliation({
      now: 101,
      requestedAt: 100,
      lostAt: 190,
      processState: "RUNNING",
    }),
  ).toEqual({ action: "REQUEST_TERMINATION" });
});

test("timeout never claims TIMED_OUT without confirmed local termination", () => {
  expect(
    decideCancellationReconciliation({
      now: 200,
      requestedAt: 200,
      lostAt: 290,
      processState: "UNREACHABLE",
      reason: "DEADLINE",
    }),
  ).toEqual({ action: "AWAIT_RECONCILIATION" });
  expect(
    decideCancellationReconciliation({
      now: 201,
      requestedAt: 200,
      lostAt: 290,
      processState: "TERMINATED",
      reason: "DEADLINE",
    }),
  ).toEqual({ action: "CONFIRM_TIMED_OUT" });
});

test("confirmed cancellation is applied only through ExecutionAuthority", async () => {
  const commands: unknown[] = [];
  const reconciler = createRunReconciler({
    authority: {
      execute: async (command: unknown) => {
        commands.push(command);
        return { ok: true, value: { kind: "ACCEPT_ATTEMPT_EVENT" } };
      },
    } as unknown as ExecutionAuthority,
    terminateOrQuarantine: async () => ({ ok: true, value: undefined }),
  });
  expect(
    await reconciler.reconcileCancellation({
      runnerId: "runner_1",
      runnerEpoch: 2,
      runId: "run_1",
      expectedRunRevision: 4,
      attemptId: "attempt_1",
      expectedAttemptRevision: 3,
      now: 101,
      requestedAt: 100,
      lostAt: 190,
      processState: "TERMINATED",
    }),
  ).toMatchObject({ ok: true, value: { action: "CONFIRM_CANCELLED" } });
  expect(commands).toEqual([
    {
      kind: "ACCEPT_ATTEMPT_EVENT",
      idempotencyKey: "cancellation:runner_1:attempt_1:101",
      actor: { kind: "RUNNER", runnerId: "runner_1", runnerEpoch: 2 },
      runId: "run_1",
      expectedRunRevision: 4,
      attemptId: "attempt_1",
      expectedAttemptRevision: 3,
      event: { kind: "CANCELLED", observedAt: 101, confirmation: "PROCESS_TERMINATED" },
    },
  ]);
});
