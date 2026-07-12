import { expect, test } from "bun:test";
import { createRunnerExecutionAuthorityAdapter } from "../../src/server/adapters/wss/execution-authority.ts";
import type { VerifiedRunnerPrincipal } from "../../src/shared/contracts/actors.ts";
import { type CollabCommand, CollabCommandSchema } from "../../src/shared/contracts/commands.ts";
import type { RunnerEnvelope } from "../../src/shared/contracts/protocol.ts";

const principal = {
  kind: "VERIFIED_RUNNER",
  runnerId: "runner_1",
  runnerEpoch: 7,
  ownerMemberId: "member_1",
  keyThumbprint: "thumbprint_1",
  accessExpiresAt: 2_000,
} as unknown as VerifiedRunnerPrincipal;

type SemanticBody = Exclude<
  RunnerEnvelope["body"],
  Readonly<{
    kind: "HEARTBEAT" | "HEADLESS_OUTPUT_CHUNK" | "OPERATION_ACKNOWLEDGEMENT" | "GATE_EVENT";
  }>
>;

test("runner semantic bodies reconstruct strict ExecutionAuthority commands from verified context", async () => {
  const commands: CollabCommand[] = [];
  const authority = {
    preview: async () => ({
      ok: false as const,
      error: { code: "NO", message: "No.", retry: "NEVER" as const },
    }),
    execute: async (command: CollabCommand) => {
      commands.push(command);
      return {
        ok: true as const,
        value: { kind: "RELEASE_AUTHORITY_SESSION", released: true as const },
      };
    },
    query: async () => ({
      ok: false as const,
      error: { code: "NO", message: "No.", retry: "NEVER" as const },
    }),
  };
  const adapter = createRunnerExecutionAuthorityAdapter(authority as never);
  const shared = { runId: "run_1", expectedRunRevision: 1, attemptId: "attempt_1" };
  const bodies: SemanticBody[] = [
    {
      kind: "CONSUME_DISPATCH_PERMIT",
      eventId: "event_1",
      requestId: "request_1",
      payload: { permit: "permit_1" },
    },
    {
      kind: "RENEW_AUTHORITY_SESSION",
      eventId: "event_2",
      requestId: "request_2",
      payload: { sessionId: "session_1", sessionFence: 1 },
    },
    {
      kind: "RELEASE_AUTHORITY_SESSION",
      eventId: "event_3",
      requestId: "request_3",
      payload: { sessionId: "session_1", sessionFence: 1, reason: "CHECKPOINTED" },
    },
    {
      kind: "AUTHORIZE_OPERATION",
      eventId: "event_4",
      requestId: "request_4",
      payload: {
        sessionId: "session_1",
        sessionFence: 1,
        operation: { kind: "MUTATE_REPOSITORY", expectedHead: "a".repeat(40) },
      },
    },
    {
      kind: "ATTEMPT_EVENT",
      eventId: "event_5",
      payload: {
        ...shared,
        expectedAttemptRevision: 1,
        event: { kind: "PROCESS_EXITED", observedAt: 1_000, exitCode: 1, signal: "SIGTERM" },
      },
    },
    {
      kind: "CHECKPOINT",
      eventId: "event_6",
      payload: {
        ...shared,
        reason: "RECOVERY",
        requestedAction: "RESUME",
        summary: "Progress",
        worktreeIdentity: "worktree_1",
        evidenceIds: [],
        sourceRevisions: {},
        resumeGuidance: "Continue",
      },
    },
    {
      kind: "EVIDENCE",
      eventId: "event_7",
      payload: {
        ...shared,
        evidence: {
          kind: "CHANGED_PATHS",
          baseCommit: "a".repeat(40),
          observedAt: 1_000,
          paths: ["src/index.ts"],
          truncated: false,
        },
      },
    },
    {
      kind: "RUN_RESULT",
      eventId: "event_8",
      payload: { ...shared, result: "DELIVERED", summary: "Done", evidenceIds: [] },
    },
  ];

  for (const body of bodies) {
    expect(await adapter.accept(body, principal, "connection_1")).toMatchObject({ ok: true });
  }
  expect(commands.every((command) => CollabCommandSchema.safeParse(command).success)).toBeTrue();
  expect(commands.map((command) => command.kind)).toEqual([
    "CONSUME_PERMIT",
    "RENEW_AUTHORITY_SESSION",
    "RELEASE_AUTHORITY_SESSION",
    "AUTHORIZE_OPERATION",
    "ACCEPT_ATTEMPT_EVENT",
    "RECORD_CHECKPOINT",
    "RECORD_EVIDENCE",
    "RECORD_RUN_RESULT",
  ]);
  expect(commands[0]).toMatchObject({
    idempotencyKey: "event_1",
    actor: { kind: "RUNNER", runnerId: "runner_1", runnerEpoch: 7 },
    runnerId: "runner_1",
    runnerEpoch: 7,
    connectionId: "connection_1",
  });
  expect(commands[1]).toMatchObject({ runnerEpoch: 7 });
  expect(commands[5]).toMatchObject({ runnerId: "runner_1" });
  expect(JSON.stringify(commands)).not.toContain("ownerMemberId");
  expect(JSON.stringify(commands)).not.toContain("keyThumbprint");
});
