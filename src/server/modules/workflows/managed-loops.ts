import type { AuthorizeAttempt } from "../../../shared/contracts/commands.ts";
import type { ExecutionAuthority } from "../../../shared/contracts/execution-authority.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { ConsecutiveMatchState } from "../../../shared/contracts/stop-policies.ts";
import type { StopPolicy } from "../../../shared/contracts/stop-policies.ts";
import { stableJson } from "../templates/run-templates.ts";

export type ManagedLoopState = Readonly<{
  attemptsCreated: number;
  maximumAttempts: number;
  absoluteDeadlineAt: number;
  consecutiveState: ConsecutiveMatchState;
}>;
export type ManagedLoopEvent = Readonly<{
  kind: "FAILED_TO_START" | "LOST" | "ATTEMPT_CREATED" | "REQUEST_NEXT";
  observedAt: number;
}>;

function failure(code: string, message: string): Result<ManagedLoopState> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

export function advanceManagedLoop(
  state: ManagedLoopState,
  event: ManagedLoopEvent,
): Result<ManagedLoopState> {
  if (
    !Number.isInteger(state.maximumAttempts) ||
    state.maximumAttempts < 1 ||
    !Number.isFinite(state.absoluteDeadlineAt) ||
    state.absoluteDeadlineAt < 1
  )
    return failure("MANAGED_LOOP_BOUND_INVALID", "Managed Loop bounds are invalid.");
  if (event.observedAt >= state.absoluteDeadlineAt)
    return failure("WORKFLOW_DEADLINE_EXCEEDED", "The workflow deadline was exceeded.");
  if (event.kind === "REQUEST_NEXT") {
    return state.attemptsCreated >= state.maximumAttempts
      ? failure("ATTEMPT_BUDGET_EXHAUSTED", "The attempt budget was exhausted.")
      : { ok: true, value: state };
  }
  const attemptsCreated = state.attemptsCreated + 1;
  if (attemptsCreated > state.maximumAttempts)
    return failure("ATTEMPT_BUDGET_EXHAUSTED", "The attempt budget was exhausted.");
  return { ok: true, value: { ...state, attemptsCreated } };
}

export async function authorizeManagedLoopIteration(
  authority: ExecutionAuthority,
  command: AuthorizeAttempt,
) {
  if (command.cause.kind !== "MANAGED_LOOP") throw new Error("MANAGED_LOOP_CAUSE_REQUIRED");
  return authority.execute(command);
}

export function createManagedLoopStore(database: Database) {
  const read = (runId: string): ManagedLoopState | null => {
    const row = database
      .query<
        {
          attempts_created: number;
          maximum_attempts: number;
          absolute_deadline_at: number;
          consecutive_state_json: string;
        },
        [string]
      >(
        `SELECT attempts_created, maximum_attempts, absolute_deadline_at, consecutive_state_json
         FROM managed_loop_state WHERE run_id = ?`,
      )
      .get(runId);
    return row
      ? {
          attemptsCreated: row.attempts_created,
          maximumAttempts: row.maximum_attempts,
          absoluteDeadlineAt: row.absolute_deadline_at,
          consecutiveState: JSON.parse(row.consecutive_state_json) as ConsecutiveMatchState,
        }
      : null;
  };
  return {
    read,
    create(
      runId: string,
      stopPolicy: StopPolicy,
      state: ManagedLoopState,
    ): Result<ManagedLoopState> {
      if (read(runId))
        return failure("MANAGED_LOOP_ALREADY_EXISTS", "Managed Loop state already exists.");
      database
        .query<void, [string, string, string, number, number, number]>(
          `INSERT INTO managed_loop_state(
             run_id, stop_policy_json, consecutive_state_json, attempts_created,
             maximum_attempts, absolute_deadline_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          stableJson(stopPolicy),
          stableJson(state.consecutiveState),
          state.attemptsCreated,
          state.maximumAttempts,
          state.absoluteDeadlineAt,
        );
      return { ok: true, value: state };
    },
    record(runId: string, event: ManagedLoopEvent): Result<ManagedLoopState> {
      const current = read(runId);
      if (!current) return failure("MANAGED_LOOP_NOT_FOUND", "Managed Loop state was not found.");
      const advanced = advanceManagedLoop(current, event);
      if (!advanced.ok) return advanced;
      database
        .query<void, [number, string, string]>(
          `UPDATE managed_loop_state
           SET attempts_created = ?, consecutive_state_json = ? WHERE run_id = ?`,
        )
        .run(advanced.value.attemptsCreated, stableJson(advanced.value.consecutiveState), runId);
      return advanced;
    },
  };
}
import type { Database } from "bun:sqlite";
