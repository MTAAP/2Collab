import { describe, expect, test } from "bun:test";
import { transitionAttempt, transitionRun } from "../../../src/server/modules/runs/lifecycle.ts";

describe("run and attempt lifecycle reducers", () => {
  test("keeps terminal attempts immutable and records process termination facts", () => {
    const started = transitionAttempt("STARTING", {
      kind: "PROCESS_STARTED",
      observedAt: 10,
    });
    expect(started).toEqual({ ok: true, value: "RUNNING" });

    const exited = transitionAttempt("RUNNING", {
      kind: "PROCESS_EXITED",
      observedAt: 11,
      exitCode: 143,
      signal: "SIGTERM",
      correlationId: "correlation_1",
    });
    expect(exited).toEqual({ ok: true, value: "EXITED" });
    expect(transitionAttempt("EXITED", { kind: "LOST", observedAt: 12 })).toMatchObject({
      ok: false,
      error: { code: "ATTEMPT_TRANSITION_INVALID" },
    });
  });

  test("lost attempts wait while explicit resume starts a new run phase", () => {
    expect(transitionRun("RUNNING", { kind: "ATTEMPT_LOST" })).toEqual({
      ok: true,
      value: { state: "WAITING", waitingReason: "RETRY" },
    });
    expect(transitionRun("WAITING", { kind: "ATTEMPT_AUTHORIZED" })).toEqual({
      ok: true,
      value: { state: "RUNNING" },
    });
  });

  test("keeps terminal runs immutable", () => {
    expect(transitionRun("COMPLETED", { kind: "ATTEMPT_AUTHORIZED" })).toMatchObject({
      ok: false,
      error: { code: "RUN_TERMINAL" },
    });
  });
});
