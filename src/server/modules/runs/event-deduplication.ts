import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";

const InputSchema = z
  .object({
    runnerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    eventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    attemptId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
      .optional(),
    eventKind: z.enum([
      "ATTEMPT_EVENT",
      "CHECKPOINT",
      "EVIDENCE",
      "RUN_RESULT",
      "TERMINATION_CONFIRMATION",
    ]),
    localSequence: z.number().int().positive(),
    predecessorEventId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
      .optional(),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type RunnerEventAcceptanceInput = Readonly<z.infer<typeof InputSchema>>;
export type RunnerEventApplied = Readonly<{
  resultReference: string;
  disposition: "APPLIED" | "REJECTED";
}>;
export type RunnerEventAcceptance = Readonly<{
  disposition: "APPLIED" | "REJECTED" | "DUPLICATE";
  resultReference: string;
}>;

function failure<T>(
  code: string,
  message: string,
  retry: "NEVER" | "REFRESH" = "NEVER",
): Result<T> {
  return { ok: false, error: { code, message, retry } };
}

type Stored = Readonly<{
  input_hash: string;
  committed_result_id: string;
  disposition: "APPLIED" | "REPLAYED" | "REJECTED";
}>;

export function createRunnerEventDeduplicator(
  dependencies: Readonly<{
    database: Database;
    clock: () => number;
    id: (kind: "accepted_event_ack" | "audit") => string;
  }>,
) {
  const inspect = (
    input: RunnerEventAcceptanceInput,
  ): Result<RunnerEventAcceptance> | undefined => {
    const stored = dependencies.database
      .query<Stored, [string, string]>(
        `SELECT input_hash, committed_result_id, disposition
         FROM accepted_runner_events WHERE runner_id = ? AND semantic_event_id = ?`,
      )
      .get(input.runnerId, input.eventId);
    if (!stored) return undefined;
    return stored.input_hash === input.inputHash
      ? {
          ok: true,
          value: {
            disposition: "DUPLICATE",
            resultReference: stored.committed_result_id,
          },
        }
      : failure(
          "RUNNER_EVENT_ID_CONFLICT",
          "Runner event identifier conflicts with accepted content.",
        );
  };

  const validateOrder = (input: RunnerEventAcceptanceInput): Result<void> => {
    const latest = dependencies.database
      .query<{ semantic_event_id: string; local_sequence: number }, [string, string]>(
        `SELECT semantic_event_id, local_sequence FROM accepted_runner_events
         WHERE runner_id = ? AND run_id = ? ORDER BY local_sequence DESC LIMIT 1`,
      )
      .get(input.runnerId, input.runId);
    if (!latest) {
      return input.localSequence === 1 && input.predecessorEventId === undefined
        ? { ok: true, value: undefined }
        : failure(
            "RUNNER_EVENT_OUT_OF_ORDER",
            "Runner event causal predecessor is unavailable.",
            "REFRESH",
          );
    }
    return input.localSequence === latest.local_sequence + 1 &&
      input.predecessorEventId === latest.semantic_event_id
      ? { ok: true, value: undefined }
      : failure(
          "RUNNER_EVENT_OUT_OF_ORDER",
          "Runner event causal predecessor is unavailable.",
          "REFRESH",
        );
  };

  const prepare = (
    candidate: RunnerEventAcceptanceInput,
  ): Result<Readonly<{ state: "NEW" | "DUPLICATE"; resultReference?: string }>> => {
    const parsed = InputSchema.safeParse(candidate);
    if (!parsed.success) {
      return failure("RUNNER_EVENT_INVALID", "Runner semantic event is invalid.");
    }
    const replay = inspect(parsed.data);
    if (replay) {
      return replay.ok
        ? { ok: true, value: { state: "DUPLICATE", resultReference: replay.value.resultReference } }
        : replay;
    }
    const order = validateOrder(parsed.data);
    return order.ok ? { ok: true, value: { state: "NEW" } } : order;
  };

  const commit = (
    candidate: RunnerEventAcceptanceInput,
    applied: RunnerEventApplied,
  ): RunnerEventAcceptance => {
    const input = InputSchema.parse(candidate);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(applied.resultReference)) {
      throw new Error("RUNNER_EVENT_RESULT_INVALID");
    }
    const now = Math.floor(dependencies.clock());
    dependencies.database
      .query(
        `INSERT INTO accepted_runner_events(
           runner_id, semantic_event_id, run_id, attempt_id, schema_version, event_kind,
           local_sequence, predecessor_event_id, input_hash, committed_result_id,
           disposition, accepted_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runnerId,
        input.eventId,
        input.runId,
        input.attemptId ?? null,
        input.eventKind,
        input.localSequence,
        input.predecessorEventId ?? null,
        input.inputHash,
        applied.resultReference,
        applied.disposition,
        now,
      );
    const semanticDigest = createHash("sha256")
      .update(
        JSON.stringify({
          runnerId: input.runnerId,
          eventId: input.eventId,
          inputHash: input.inputHash,
          resultReference: applied.resultReference,
          disposition: applied.disposition,
        }),
        "utf8",
      )
      .digest("hex");
    dependencies.database
      .query(
        `INSERT INTO accepted_event_ack_outbox(
           id, runner_id, semantic_event_id, result_reference, semantic_digest,
           state, retry_count, created_at
         ) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?)`,
      )
      .run(
        dependencies.id("accepted_event_ack"),
        input.runnerId,
        input.eventId,
        applied.resultReference,
        semanticDigest,
        now,
      );
    dependencies.database
      .query(
        `INSERT INTO audit_events(
           id, kind, actor_kind, actor_id, subject_id, safe_details, created_at
         ) VALUES (?, 'RUNNER_SEMANTIC_EVENT_ACCEPTED', 'RUNNER', ?, ?, ?, ?)`,
      )
      .run(
        dependencies.id("audit"),
        input.runnerId,
        input.runId,
        JSON.stringify({
          eventKind: input.eventKind,
          localSequence: input.localSequence,
          disposition: applied.disposition,
        }),
        now,
      );
    return {
      disposition: applied.disposition,
      resultReference: applied.resultReference,
    };
  };

  return {
    inspect,
    prepare,
    commit,

    accept(
      candidate: RunnerEventAcceptanceInput,
      effect: () => Result<RunnerEventApplied>,
    ): Result<RunnerEventAcceptance> {
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const prepared = prepare(candidate);
          if (!prepared.ok) return prepared;
          if (prepared.value.state === "DUPLICATE") {
            return {
              ok: true,
              value: {
                disposition: "DUPLICATE",
                resultReference: prepared.value.resultReference ?? candidate.eventId,
              },
            };
          }
          const applied = effect();
          if (!applied.ok) return applied;
          return { ok: true, value: commit(candidate, applied.value) };
        });
      } catch {
        return failure(
          "RUNNER_EVENT_STORAGE_FAILED",
          "Runner semantic event acceptance failed.",
          "REFRESH",
        );
      }
    },
  };
}
