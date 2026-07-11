import type { AuthorizeAttempt } from "../../../shared/contracts/commands.ts";
import type { ExecutionAuthority } from "../../../shared/contracts/execution-authority.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { ConsecutiveMatchState } from "../../../shared/contracts/stop-policies.ts";
import type { StopPolicy } from "../../../shared/contracts/stop-policies.ts";
import type { StopPolicyFacts } from "../../../shared/contracts/stop-policies.ts";
import { stableJson } from "../templates/run-templates.ts";
import { evaluateStopPolicy } from "./stop-policy.ts";

export type ManagedLoopState = Readonly<{
  attemptsCreated: number;
  maximumAttempts: number;
  absoluteDeadlineAt: number;
  consecutiveState: ConsecutiveMatchState;
}>;
export type ManagedLoopEvent = Readonly<{
  kind: "FAILED_TO_START" | "LOST" | "ATTEMPT_CREATED" | "REQUEST_NEXT";
  observedAt: number;
  eventId?: string;
  attemptId?: string;
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
      if (
        (event.attemptId !== undefined && event.eventId === undefined) ||
        (event.kind !== "REQUEST_NEXT" &&
          event.eventId !== undefined &&
          event.attemptId === undefined) ||
        (event.kind === "REQUEST_NEXT" && event.attemptId !== undefined)
      )
        return failure("MANAGED_LOOP_EVENT_INVALID", "Managed Loop event identity is invalid.");
      return database.transaction(() => {
        const current = read(runId);
        if (!current) return failure("MANAGED_LOOP_NOT_FOUND", "Managed Loop state was not found.");
        if (event.eventId) {
          const prior = database
            .query<{ run_id: string; attempt_id: string | null; kind: string }, [string]>(
              "SELECT run_id, attempt_id, kind FROM managed_loop_events WHERE event_id = ?",
            )
            .get(event.eventId);
          if (prior)
            return prior.run_id === runId &&
              prior.attempt_id === event.attemptId &&
              prior.kind === event.kind
              ? { ok: true as const, value: current }
              : failure("MANAGED_LOOP_EVENT_CONFLICT", "Managed Loop event identity was reused.");
        }
        const advanced = advanceManagedLoop(current, event);
        if (!advanced.ok) return advanced;
        database
          .query<void, [number, string, string]>(
            `UPDATE managed_loop_state
             SET attempts_created = ?, consecutive_state_json = ? WHERE run_id = ?`,
          )
          .run(advanced.value.attemptsCreated, stableJson(advanced.value.consecutiveState), runId);
        if (event.eventId)
          database
            .query<void, [string, string, string, string, number]>(
              `INSERT INTO managed_loop_events(event_id, run_id, attempt_id, kind, observed_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(event.eventId, runId, event.attemptId as string, event.kind, event.observedAt);
        return advanced;
      })();
    },
    evaluate(runId: string, evaluationId: string, facts: StopPolicyFacts, evaluatedAt: number) {
      const factsDigest = new Bun.CryptoHasher("sha256").update(stableJson(facts)).digest("hex");
      return database.transaction(() => {
        const prior = database
          .query<
            { facts_digest: string; result: "TRUE" | "FALSE" | "UNKNOWN"; state_json: string },
            [string]
          >(
            `SELECT facts_digest, result, state_json FROM managed_loop_policy_evaluations
             WHERE evaluation_id = ?`,
          )
          .get(evaluationId);
        if (prior)
          return prior.facts_digest === factsDigest
            ? {
                ok: true as const,
                value: {
                  result: prior.result,
                  state: JSON.parse(prior.state_json) as ConsecutiveMatchState,
                },
              }
            : failure(
                "MANAGED_LOOP_EVALUATION_CONFLICT",
                "Managed Loop evaluation identity was reused.",
              );
        const row = database
          .query<{ stop_policy_json: string }, [string]>(
            "SELECT stop_policy_json FROM managed_loop_state WHERE run_id = ?",
          )
          .get(runId);
        const current = read(runId);
        if (!row || !current)
          return failure("MANAGED_LOOP_NOT_FOUND", "Managed Loop state was not found.");
        const evaluated = evaluateStopPolicy(
          JSON.parse(row.stop_policy_json) as StopPolicy,
          facts,
          current.consecutiveState,
        );
        database
          .query<void, [string, string]>(
            "UPDATE managed_loop_state SET consecutive_state_json = ? WHERE run_id = ?",
          )
          .run(stableJson(evaluated.state), runId);
        database
          .query<void, [string, string, string, string, string, number]>(
            `INSERT INTO managed_loop_policy_evaluations(
               evaluation_id, run_id, facts_digest, result, state_json, evaluated_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            evaluationId,
            runId,
            factsDigest,
            evaluated.result,
            stableJson(evaluated.state),
            evaluatedAt,
          );
        return { ok: true as const, value: evaluated };
      })();
    },
  };
}
import type { Database } from "bun:sqlite";
