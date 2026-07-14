import { describe, expect, test } from "bun:test";
import {
  type CheckpointInput,
  createCheckpoint,
} from "../../../src/server/modules/runs/checkpoints.ts";
import { createEvidence } from "../../../src/server/modules/runs/evidence.ts";
import { evaluateRunResult } from "../../../src/server/modules/runs/results.ts";

const checkpoint: CheckpointInput = {
  id: "checkpoint_1",
  runId: "run_1",
  attemptId: "attempt_1",
  reason: "RECOVERY",
  requestedAction: "RESUME",
  summary: "Runner state was checkpointed.",
  runnerId: "runner_1",
  worktreeIdentity: "worktree_1",
  currentCommit: "a".repeat(40),
  evidenceIds: ["evidence_1"],
  sourceRevisions: { issue_1: "42" },
  resumeGuidance: "Resume from the durable goal and current worktree.",
  createdAt: 100,
};

describe("typed durable run records", () => {
  test("checkpoint preserves complete bounded recovery facts", () => {
    const created = createCheckpoint(checkpoint);
    expect(created.ok).toBeTrue();
    if (created.ok) expect(created.value as unknown).toEqual(checkpoint as unknown);
    expect(createCheckpoint({ ...checkpoint, resumeGuidance: "x".repeat(2_049) })).toMatchObject({
      ok: false,
      error: { code: "CHECKPOINT_INVALID" },
    });
  });

  test("evidence accepts structured facts and rejects open output", () => {
    expect(
      createEvidence({
        id: "evidence_1",
        runId: "run_1",
        attemptId: "attempt_1",
        evidence: {
          kind: "VERIFICATION",
          name: "focused tests",
          outcome: "PASSED",
          durationMs: 20,
          summary: "All focused tests passed.",
        },
        createdAt: 100,
      }),
    ).toMatchObject({ ok: true });
    expect(
      createEvidence({
        id: "evidence_2",
        runId: "run_1",
        evidence: { kind: "RAW_OUTPUT", value: "secret" } as never,
        createdAt: 100,
      }),
    ).toMatchObject({ ok: false, error: { code: "EVIDENCE_INVALID" } });
  });

  test("blocked and escalated results require a typed reason and next action", () => {
    expect(
      evaluateRunResult({
        kind: "BLOCKED",
        summary: "Needs a replacement runner.",
        reason: "RUNNER_UNAVAILABLE",
        requestedAction: "SELECT_RUNNER",
        evidenceIds: [],
      }),
    ).toEqual({
      ok: true,
      value: { state: "WAITING", waitingReason: "BLOCKED" },
    });
    expect(
      evaluateRunResult({
        kind: "ESCALATED",
        summary: "Human decision required.",
        evidenceIds: [],
      } as never),
    ).toMatchObject({ ok: false, error: { code: "RESULT_CONTRACT_VIOLATION" } });
  });
});
