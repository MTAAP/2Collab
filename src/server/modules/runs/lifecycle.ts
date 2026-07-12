import type { z } from "zod";
import type { Result } from "../../../shared/contracts/result.ts";
import type {
  AgentRunState,
  AttemptEventSchema,
  ExecutionAttemptState,
} from "../../../shared/contracts/runs.ts";

type AttemptEvent = z.infer<typeof AttemptEventSchema>;

export type RunLifecycleEvent =
  | Readonly<{ kind: "ATTEMPT_AUTHORIZED" }>
  | Readonly<{ kind: "ATTEMPT_STARTED" }>
  | Readonly<{ kind: "ATTEMPT_LOST" }>
  | Readonly<{ kind: "CHECKPOINTED"; waitingReason: "HUMAN_INPUT" | "RETRY" | "BLOCKED" }>
  | Readonly<{ kind: "COMPLETE"; reason: "GOAL_ACHIEVED" | "DELIVERED" | "NO_CHANGES" }>
  | Readonly<{ kind: "FAIL"; reason: "BLOCKED" | "DEADLINE" | "FAILED" }>
  | Readonly<{ kind: "CANCEL" }>;

export type RunTransition = Readonly<{
  state: AgentRunState;
  waitingReason?: "HUMAN_INPUT" | "RETRY" | "BLOCKED";
}>;

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "REFRESH" } };
}

export function transitionAttempt(
  current: ExecutionAttemptState,
  event: AttemptEvent,
): Result<ExecutionAttemptState> {
  const next = (() => {
    switch (event.kind) {
      case "ACKNOWLEDGED":
        return current === "PENDING" ? "STARTING" : undefined;
      case "PROCESS_STARTED":
        return current === "STARTING" ? "RUNNING" : undefined;
      case "PROCESS_EXITED":
        return current === "RUNNING" ? "EXITED" : undefined;
      case "FAILED_TO_START":
        return current === "STARTING" ? "FAILED_TO_START" : undefined;
      case "TERMINATION_REQUESTED":
        return ["PENDING", "STARTING", "RUNNING"].includes(current) ? current : undefined;
      case "CANCELLED":
        return ["PENDING", "STARTING", "RUNNING"].includes(current) ? "CANCELLED" : undefined;
      case "TIMED_OUT":
        return current === "RUNNING" ? "TIMED_OUT" : undefined;
      case "LOST":
        return ["PENDING", "STARTING", "RUNNING"].includes(current) ? "LOST" : undefined;
    }
  })();
  return next
    ? { ok: true, value: next as ExecutionAttemptState }
    : failure("ATTEMPT_TRANSITION_INVALID", "The attempt event is invalid for its current state.");
}

export function transitionRun(
  current: AgentRunState,
  event: RunLifecycleEvent,
): Result<RunTransition> {
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(current)) {
    return failure("RUN_TERMINAL", "The Agent Run is terminal.");
  }
  switch (event.kind) {
    case "ATTEMPT_AUTHORIZED":
    case "ATTEMPT_STARTED":
      return { ok: true, value: { state: "RUNNING" } };
    case "ATTEMPT_LOST":
      return { ok: true, value: { state: "WAITING", waitingReason: "RETRY" } };
    case "CHECKPOINTED":
      return {
        ok: true,
        value: { state: "WAITING", waitingReason: event.waitingReason },
      };
    case "COMPLETE":
      return { ok: true, value: { state: "COMPLETED" } };
    case "FAIL":
      return { ok: true, value: { state: "FAILED" } };
    case "CANCEL":
      return { ok: true, value: { state: "CANCELLED" } };
  }
}
