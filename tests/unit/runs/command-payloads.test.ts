import { describe, expect, test } from "bun:test";
import {
  AcceptAttemptEventPayloadSchema,
  AuthorizeOperationPayloadSchema,
  ConsumePermitPayloadSchema,
  RecordCheckpointPayloadSchema,
  RecordEvidencePayloadSchema,
  RecordRunResultPayloadSchema,
  ReleaseAuthoritySessionPayloadSchema,
  RenewAuthoritySessionPayloadSchema,
  SensitiveOperationSchema,
} from "../../../src/shared/contracts/commands.ts";

const commit = "a".repeat(40);

describe("execution authority command payloads", () => {
  test("exports complete attempt and operation payloads for protocol adapters", () => {
    expect(
      AcceptAttemptEventPayloadSchema.safeParse({
        runId: "run_1",
        expectedRunRevision: 3,
        attemptId: "attempt_1",
        expectedAttemptRevision: 2,
        event: {
          kind: "PROCESS_EXITED",
          observedAt: 100,
          exitCode: 0,
          signal: "SIGTERM",
          correlationId: "correlation_1",
        },
      }).success,
    ).toBe(true);
    expect(
      AcceptAttemptEventPayloadSchema.safeParse({
        runId: "run_1",
        attemptId: "attempt_1",
        event: { kind: "LOST", observedAt: 100 },
      }).success,
    ).toBe(false);

    const operation = {
      kind: "MUTATE_REPOSITORY",
      expectedHead: commit,
    } as const;
    expect(SensitiveOperationSchema.safeParse(operation).success).toBe(true);
    expect(
      AuthorizeOperationPayloadSchema.safeParse({
        sessionId: "authority_session_1",
        sessionFence: 4,
        operation,
      }).success,
    ).toBe(true);
    expect(
      AuthorizeOperationPayloadSchema.safeParse({
        sessionId: "authority_session_1",
        operation,
      }).success,
    ).toBe(false);

    expect(
      ConsumePermitPayloadSchema.safeParse({
        permit: "signed-permit",
        runnerId: "runner_1",
        runnerEpoch: 2,
        connectionId: "connection_1",
      }).success,
    ).toBe(true);
    expect(
      RenewAuthoritySessionPayloadSchema.safeParse({
        sessionId: "authority_session_1",
        sessionFence: 4,
        runnerEpoch: 2,
      }).success,
    ).toBe(true);
    expect(
      ReleaseAuthoritySessionPayloadSchema.safeParse({
        sessionId: "authority_session_1",
        sessionFence: 4,
        reason: "CHECKPOINTED",
      }).success,
    ).toBe(true);
  });

  test("keeps checkpoint and evidence payloads bounded and closed", () => {
    const checkpoint = {
      runId: "run_1",
      expectedRunRevision: 3,
      attemptId: "attempt_1",
      reason: "RECOVERY",
      requestedAction: "RESUME",
      summary: "Resume from the durable checkpoint.",
      runnerId: "runner_1",
      worktreeIdentity: "worktree_1",
      currentCommit: commit,
      evidenceIds: [],
      sourceRevisions: { issue_1: "etag-3" },
      resumeGuidance: "Continue from the current worktree state.",
    } as const;
    expect(RecordCheckpointPayloadSchema.safeParse(checkpoint).success).toBe(true);
    expect(
      RecordCheckpointPayloadSchema.safeParse({ ...checkpoint, transcript: "local secret" })
        .success,
    ).toBe(false);

    const evidence = {
      runId: "run_1",
      expectedRunRevision: 3,
      attemptId: "attempt_1",
      evidence: {
        kind: "VERIFICATION",
        name: "test",
        outcome: "PASSED",
        durationMs: 42,
        summary: "Focused tests passed.",
      },
    } as const;
    expect(RecordEvidencePayloadSchema.safeParse(evidence).success).toBe(true);
    expect(
      RecordEvidencePayloadSchema.safeParse({ ...evidence, rawOutput: "secret" }).success,
    ).toBe(false);
  });

  test("requires typed blocked results and forbids their fields on delivered results", () => {
    const base = {
      runId: "run_1",
      expectedRunRevision: 3,
      attemptId: "attempt_1",
      summary: "Run result.",
      evidenceIds: [],
    } as const;
    expect(RecordRunResultPayloadSchema.safeParse({ ...base, result: "DELIVERED" }).success).toBe(
      true,
    );
    expect(
      RecordRunResultPayloadSchema.safeParse({
        ...base,
        result: "DELIVERED",
        reason: "BLOCKED",
      }).success,
    ).toBe(false);
    expect(
      RecordRunResultPayloadSchema.safeParse({
        ...base,
        result: "BLOCKED",
        reason: "DEPENDENCY_UNAVAILABLE",
        requestedAction: "RESUME",
      }).success,
    ).toBe(true);
    expect(RecordRunResultPayloadSchema.safeParse({ ...base, result: "BLOCKED" }).success).toBe(
      false,
    );
  });
});
