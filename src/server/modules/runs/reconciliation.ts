import { z } from "zod";
import type { ExecutionAuthority } from "../../../shared/contracts/execution-authority.ts";
import type { Result } from "../../../shared/contracts/result.ts";

const CancellationInputSchema = z
  .object({
    now: z.number().int().nonnegative(),
    requestedAt: z.number().int().nonnegative(),
    lostAt: z.number().int().nonnegative(),
    processState: z.enum(["NOT_STARTED", "RUNNING", "TERMINATED", "UNREACHABLE"]),
    reason: z.enum(["CANCELLATION", "DEADLINE"]).default("CANCELLATION"),
  })
  .strict()
  .refine((input) => input.lostAt >= input.requestedAt);

export function decideCancellationReconciliation(
  candidate: z.input<typeof CancellationInputSchema>,
):
  | Readonly<{
      action: "CONFIRM_CANCELLED";
      confirmation: "PROCESS_NOT_STARTED" | "PROCESS_TERMINATED";
    }>
  | Readonly<{ action: "CONFIRM_TIMED_OUT" }>
  | Readonly<{ action: "REQUEST_TERMINATION" }>
  | Readonly<{ action: "AWAIT_RECONCILIATION" }>
  | Readonly<{ action: "MARK_LOST" }> {
  const input = CancellationInputSchema.parse(candidate);
  if (input.processState === "NOT_STARTED") {
    return { action: "CONFIRM_CANCELLED", confirmation: "PROCESS_NOT_STARTED" };
  }
  if (input.processState === "TERMINATED") {
    return input.reason === "DEADLINE"
      ? { action: "CONFIRM_TIMED_OUT" }
      : { action: "CONFIRM_CANCELLED", confirmation: "PROCESS_TERMINATED" };
  }
  if (input.processState === "RUNNING") return { action: "REQUEST_TERMINATION" };
  return input.now >= input.lostAt ? { action: "MARK_LOST" } : { action: "AWAIT_RECONCILIATION" };
}

const RunnerInputSchema = z
  .object({
    now: z.number().int().nonnegative(),
    lastHeartbeatAt: z.number().int().nonnegative(),
    attemptState: z.enum([
      "PENDING",
      "STARTING",
      "RUNNING",
      "EXITED",
      "FAILED_TO_START",
      "CANCELLED",
      "TIMED_OUT",
      "LOST",
    ]),
    processObservation: z.enum(["RUNNING", "EXITED", "NOT_FOUND", "UNAVAILABLE"]),
    offlineSeconds: z.number().int().positive(),
    lostSeconds: z.number().int().positive(),
  })
  .strict()
  .refine((input) => input.lostSeconds > input.offlineSeconds);

export function decideRunnerReconciliation(
  candidate: z.input<typeof RunnerInputSchema>,
):
  | Readonly<{ action: "NO_CHANGE" }>
  | Readonly<{ action: "MARK_OFFLINE" }>
  | Readonly<{ action: "AWAIT_RUNNER_RECONCILIATION" }>
  | Readonly<{ action: "MARK_LOST"; runDisposition: "WAITING_RUNNER_UNAVAILABLE" }>
  | Readonly<{ action: "TERMINATE_OR_QUARANTINE_ORPHAN" }> {
  const input = RunnerInputSchema.parse(candidate);
  const terminal = ["EXITED", "FAILED_TO_START", "CANCELLED", "TIMED_OUT", "LOST"].includes(
    input.attemptState,
  );
  if (terminal) {
    return input.attemptState === "LOST" && input.processObservation === "RUNNING"
      ? { action: "TERMINATE_OR_QUARANTINE_ORPHAN" }
      : { action: "NO_CHANGE" };
  }
  const elapsed = input.now - input.lastHeartbeatAt;
  if (elapsed < input.offlineSeconds) return { action: "NO_CHANGE" };
  if (elapsed < input.lostSeconds) {
    return elapsed === input.offlineSeconds
      ? { action: "MARK_OFFLINE" }
      : { action: "AWAIT_RUNNER_RECONCILIATION" };
  }
  return { action: "MARK_LOST", runDisposition: "WAITING_RUNNER_UNAVAILABLE" };
}

const IdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

const RunnerReconciliationRequestSchema = RunnerInputSchema.extend({
  runnerId: IdentifierSchema,
  runnerEpoch: z.number().int().nonnegative(),
  originalDispatcherId: IdentifierSchema,
  runId: IdentifierSchema,
  expectedRunRevision: z.number().int().positive(),
  attemptId: IdentifierSchema,
}).strict();

const CancellationReconciliationRequestSchema = CancellationInputSchema.extend({
  runnerId: IdentifierSchema,
  runnerEpoch: z.number().int().nonnegative(),
  originalDispatcherId: IdentifierSchema.optional(),
  runId: IdentifierSchema,
  expectedRunRevision: z.number().int().positive(),
  attemptId: IdentifierSchema,
  expectedAttemptRevision: z.number().int().positive(),
}).strict();

type HostOrphanInput = Readonly<{
  runnerId: string;
  runnerEpoch: number;
  runId: string;
  attemptId: string;
}>;

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "REFRESH" } };
}

export function createRunReconciler(
  dependencies: Readonly<{
    authority: Pick<ExecutionAuthority, "execute">;
    terminateOrQuarantine(input: HostOrphanInput): Promise<Result<void>>;
  }>,
) {
  return {
    async reconcileRunner(candidate: z.input<typeof RunnerReconciliationRequestSchema>) {
      const parsed = RunnerReconciliationRequestSchema.safeParse(candidate);
      if (!parsed.success) {
        return failure("RUNNER_RECONCILIATION_INVALID", "Runner reconciliation is invalid.");
      }
      const input = parsed.data;
      const decision = decideRunnerReconciliation({
        now: input.now,
        lastHeartbeatAt: input.lastHeartbeatAt,
        attemptState: input.attemptState,
        processObservation: input.processObservation,
        offlineSeconds: input.offlineSeconds,
        lostSeconds: input.lostSeconds,
      });
      if (decision.action === "MARK_LOST") {
        const accepted = await dependencies.authority.execute({
          kind: "RECONCILE_OBSERVATION",
          idempotencyKey: `runner-loss:${input.runnerId}:${input.attemptId}:${input.now}` as never,
          actor: {
            kind: "SCHEDULER",
            originalDispatcherId: input.originalDispatcherId as never,
          },
          runId: input.runId as never,
          expectedRunRevision: input.expectedRunRevision,
          observation: {
            kind: "RUNNER_ATTEMPT",
            attemptId: input.attemptId as never,
            observedState: "NOT_FOUND",
            observedAt: input.now,
          },
        });
        return accepted.ok ? { ok: true as const, value: decision } : accepted;
      }
      if (decision.action === "TERMINATE_OR_QUARANTINE_ORPHAN") {
        const contained = await dependencies.terminateOrQuarantine({
          runnerId: input.runnerId,
          runnerEpoch: input.runnerEpoch,
          runId: input.runId,
          attemptId: input.attemptId,
        });
        return contained.ok ? { ok: true as const, value: decision } : contained;
      }
      return { ok: true as const, value: decision };
    },

    async reconcileCancellation(
      candidate: z.input<typeof CancellationReconciliationRequestSchema>,
    ) {
      const parsed = CancellationReconciliationRequestSchema.safeParse(candidate);
      if (!parsed.success) {
        return failure(
          "CANCELLATION_RECONCILIATION_INVALID",
          "Cancellation reconciliation is invalid.",
        );
      }
      const input = parsed.data;
      const decision = decideCancellationReconciliation({
        now: input.now,
        requestedAt: input.requestedAt,
        lostAt: input.lostAt,
        processState: input.processState,
        reason: input.reason,
      });
      if (decision.action === "CONFIRM_CANCELLED" || decision.action === "CONFIRM_TIMED_OUT") {
        const event =
          decision.action === "CONFIRM_TIMED_OUT"
            ? ({
                kind: "TIMED_OUT",
                observedAt: input.now,
                confirmation: "PROCESS_TERMINATED",
              } as const)
            : ({
                kind: "CANCELLED",
                observedAt: input.now,
                confirmation: decision.confirmation,
              } as const);
        const accepted = await dependencies.authority.execute({
          kind: "ACCEPT_ATTEMPT_EVENT",
          idempotencyKey: `cancellation:${input.runnerId}:${input.attemptId}:${input.now}` as never,
          actor: {
            kind: "RUNNER",
            runnerId: input.runnerId as never,
            runnerEpoch: input.runnerEpoch,
          },
          runId: input.runId as never,
          expectedRunRevision: input.expectedRunRevision,
          attemptId: input.attemptId as never,
          expectedAttemptRevision: input.expectedAttemptRevision,
          event,
        });
        return accepted.ok ? { ok: true as const, value: decision } : accepted;
      }
      if (decision.action === "MARK_LOST") {
        if (!input.originalDispatcherId) {
          return failure(
            "RUNNER_RECONCILIATION_INVALID",
            "Runner reconciliation requires its original dispatcher.",
          );
        }
        const accepted = await dependencies.authority.execute({
          kind: "RECONCILE_OBSERVATION",
          idempotencyKey:
            `cancellation-loss:${input.runnerId}:${input.attemptId}:${input.now}` as never,
          actor: {
            kind: "SCHEDULER",
            originalDispatcherId: input.originalDispatcherId as never,
          },
          runId: input.runId as never,
          expectedRunRevision: input.expectedRunRevision,
          observation: {
            kind: "RUNNER_ATTEMPT",
            attemptId: input.attemptId as never,
            observedState: "NOT_FOUND",
            observedAt: input.now,
          },
        });
        return accepted.ok ? { ok: true as const, value: decision } : accepted;
      }
      return { ok: true as const, value: decision };
    },
  };
}
