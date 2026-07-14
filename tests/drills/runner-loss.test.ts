import { expect, test } from "bun:test";
import {
  createRunReconciler,
  decideRunnerReconciliation,
} from "../../src/server/modules/runs/reconciliation.ts";
import type { ExecutionAuthority } from "../../src/shared/contracts/execution-authority.ts";

test("runner becomes offline at 30 seconds and an active attempt becomes LOST at 90", () => {
  const base = {
    lastHeartbeatAt: 100,
    attemptState: "RUNNING" as const,
    processObservation: "UNAVAILABLE" as const,
    offlineSeconds: 30,
    lostSeconds: 90,
  };
  expect(decideRunnerReconciliation({ ...base, now: 129 })).toEqual({ action: "NO_CHANGE" });
  expect(decideRunnerReconciliation({ ...base, now: 130 })).toEqual({ action: "MARK_OFFLINE" });
  expect(decideRunnerReconciliation({ ...base, now: 189 })).toEqual({
    action: "AWAIT_RUNNER_RECONCILIATION",
  });
  expect(decideRunnerReconciliation({ ...base, now: 190 })).toEqual({
    action: "MARK_LOST",
    runDisposition: "WAITING_RUNNER_UNAVAILABLE",
  });
});

test("LOST is immutable and a later orphan is terminated or quarantined", () => {
  expect(
    decideRunnerReconciliation({
      now: 200,
      lastHeartbeatAt: 100,
      attemptState: "LOST",
      processObservation: "RUNNING",
      offlineSeconds: 30,
      lostSeconds: 90,
    }),
  ).toEqual({ action: "TERMINATE_OR_QUARANTINE_ORPHAN" });
  expect(
    decideRunnerReconciliation({
      now: 200,
      lastHeartbeatAt: 100,
      attemptState: "LOST",
      processObservation: "NOT_FOUND",
      offlineSeconds: 30,
      lostSeconds: 90,
    }),
  ).toEqual({ action: "NO_CHANGE" });
});

test("lost and orphan reconciliation consume ExecutionAuthority and the host action seam", async () => {
  const commands: unknown[] = [];
  const orphans: string[] = [];
  const authority = {
    execute: async (command: unknown) => {
      commands.push(command);
      return { ok: true, value: { kind: "RECONCILE_OBSERVATION" } };
    },
  } as unknown as ExecutionAuthority;
  const reconciler = createRunReconciler({
    authority,
    terminateOrQuarantine: async ({ attemptId }) => {
      orphans.push(attemptId);
      return { ok: true, value: undefined };
    },
  });
  const identity = {
    runnerId: "runner_1",
    runnerEpoch: 2,
    originalDispatcherId: "member_1",
    runId: "run_1",
    expectedRunRevision: 4,
    attemptId: "attempt_1",
  } as const;
  expect(
    await reconciler.reconcileRunner({
      ...identity,
      now: 190,
      lastHeartbeatAt: 100,
      attemptState: "RUNNING",
      processObservation: "UNAVAILABLE",
      offlineSeconds: 30,
      lostSeconds: 90,
    }),
  ).toMatchObject({ ok: true, value: { action: "MARK_LOST" } });
  expect(commands).toEqual([
    {
      kind: "RECONCILE_OBSERVATION",
      idempotencyKey: "runner-loss:runner_1:attempt_1:190",
      actor: { kind: "SCHEDULER", originalDispatcherId: "member_1" },
      runId: "run_1",
      expectedRunRevision: 4,
      observation: {
        kind: "RUNNER_ATTEMPT",
        attemptId: "attempt_1",
        observedState: "NOT_FOUND",
        observedAt: 190,
      },
    },
  ]);
  expect(
    await reconciler.reconcileRunner({
      ...identity,
      now: 200,
      lastHeartbeatAt: 100,
      attemptState: "LOST",
      processObservation: "RUNNING",
      offlineSeconds: 30,
      lostSeconds: 90,
    }),
  ).toMatchObject({ ok: true, value: { action: "TERMINATE_OR_QUARANTINE_ORPHAN" } });
  expect(orphans).toEqual(["attempt_1"]);
});
