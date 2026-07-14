import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { type RunnerEnvelope, RunnerMessageBodySchema } from "../shared/contracts/protocol.ts";
import type { Result } from "../shared/contracts/result.ts";

type DurableBody = Exclude<
  RunnerEnvelope["body"],
  Readonly<{ kind: "HEARTBEAT" | "HEADLESS_OUTPUT_CHUNK" }>
>;

export type SemanticOutboxState = "PENDING" | "IN_FLIGHT" | "ACKNOWLEDGED" | "PERMANENTLY_REJECTED";

export type SemanticOutboxEvent = Readonly<{
  eventId: string;
  runId?: string;
  eventKind: DurableBody["kind"];
  priority: "NORMAL" | "CRITICAL";
  digest: string;
  body: DurableBody;
  byteCount: number;
  localSequence: number;
  predecessorEventId?: string;
  state: SemanticOutboxState;
  rejectionCode?: string;
  createdAt: number;
  updatedAt: number;
}>;

type Limits = Readonly<{
  maximumItems: number;
  maximumBytes: number;
  reservedCriticalItems: number;
  reservedCriticalBytes: number;
}>;

const defaults: Limits = {
  maximumItems: 10_000,
  maximumBytes: 64 * 1024 * 1024,
  reservedCriticalItems: 1_000,
  reservedCriticalBytes: Math.floor(64 * 1024 * 1024 * 0.1),
};

type Row = Readonly<{
  event_id: string;
  run_id: string | null;
  event_kind: DurableBody["kind"];
  priority: "NORMAL" | "CRITICAL";
  body_digest: string;
  body_json: string;
  byte_count: number;
  local_sequence: number;
  predecessor_event_id: string | null;
  state: SemanticOutboxState;
  rejection_code: string | null;
  created_at: number;
  updated_at: number;
}>;

function failure<T>(
  code: string,
  message: string,
  retry: "NEVER" | "REFRESH" = "NEVER",
): Result<T> {
  return { ok: false, error: { code, message, retry } };
}

const forbiddenKeys = new Set([
  "absolutepath",
  "attachment",
  "body",
  "content",
  "credential",
  "diff",
  "environment",
  "env",
  "path",
  "permit",
  "prompt",
  "rawoutput",
  "sourcebody",
  "transcript",
]);

const durableEventKinds = new Set<DurableBody["kind"]>([
  "OPERATION_ACKNOWLEDGEMENT",
  "ATTEMPT_EVENT",
  "CHECKPOINT",
  "EVIDENCE",
  "RUN_RESULT",
  "GATE_EVENT",
]);

function containsProhibited(value: unknown, key = ""): boolean {
  const normalized = key.replaceAll(/[^A-Za-z]/g, "").toLowerCase();
  if (key !== "" && forbiddenKeys.has(normalized)) return true;
  if (typeof value === "string") return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
  if (Array.isArray(value)) return value.some((entry) => containsProhibited(entry));
  if (value && typeof value === "object") {
    return Object.entries(value).some(([entryKey, entry]) => containsProhibited(entry, entryKey));
  }
  return false;
}

function priority(body: DurableBody): "NORMAL" | "CRITICAL" {
  if (body.kind === "CHECKPOINT" || body.kind === "RUN_RESULT") return "CRITICAL";
  if (
    body.kind === "ATTEMPT_EVENT" &&
    ["PROCESS_EXITED", "FAILED_TO_START", "CANCELLED", "TIMED_OUT", "LOST"].includes(
      body.payload.event.kind,
    )
  ) {
    return "CRITICAL";
  }
  return "NORMAL";
}

function parseRow(row: Row): SemanticOutboxEvent {
  let candidate: unknown;
  try {
    candidate = JSON.parse(row.body_json);
  } catch {
    throw new Error("RUNNER_OUTBOX_CORRUPT");
  }
  const body = RunnerMessageBodySchema.safeParse(candidate);
  const digest = createHash("sha256").update(row.body_json, "utf8").digest("hex");
  if (
    !body.success ||
    body.data.kind === "HEARTBEAT" ||
    body.data.kind === "HEADLESS_OUTPUT_CHUNK" ||
    !durableEventKinds.has(body.data.kind) ||
    body.data.eventId !== row.event_id ||
    body.data.kind !== row.event_kind ||
    digest !== row.body_digest ||
    Buffer.byteLength(row.body_json, "utf8") !== row.byte_count ||
    containsProhibited(body.data)
  ) {
    throw new Error("RUNNER_OUTBOX_CORRUPT");
  }
  return {
    eventId: row.event_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    eventKind: row.event_kind,
    priority: row.priority,
    digest: row.body_digest,
    body: body.data,
    byteCount: row.byte_count,
    localSequence: row.local_sequence,
    ...(row.predecessor_event_id ? { predecessorEventId: row.predecessor_event_id } : {}),
    state: row.state,
    ...(row.rejection_code ? { rejectionCode: row.rejection_code } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createRunnerSemanticOutbox(
  database: Database,
  clock: () => number,
  configured: Partial<Limits> = {},
) {
  const limits = { ...defaults, ...configured };
  if (
    !Object.values(limits).every((value) => Number.isSafeInteger(value) && value >= 0) ||
    limits.maximumItems < 1 ||
    limits.maximumBytes < 1 ||
    limits.reservedCriticalItems >= limits.maximumItems ||
    limits.reservedCriticalBytes >= limits.maximumBytes ||
    limits.maximumItems > defaults.maximumItems ||
    limits.maximumBytes > defaults.maximumBytes
  ) {
    throw new Error("RUNNER_OUTBOX_LIMIT_INVALID");
  }
  const select = database.query<Row, [string]>(
    "SELECT * FROM local_semantic_outbox WHERE event_id = ?",
  );
  return {
    enqueue(
      input: Readonly<{ eventId: string; runId?: string; body: DurableBody }>,
    ): Result<SemanticOutboxEvent> {
      const body = RunnerMessageBodySchema.safeParse(input.body);
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.eventId) ||
        (input.runId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.runId)) ||
        !body.success ||
        body.data.kind === "HEARTBEAT" ||
        body.data.kind === "HEADLESS_OUTPUT_CHUNK" ||
        !durableEventKinds.has(body.data.kind) ||
        body.data.eventId !== input.eventId ||
        containsProhibited(body.data)
      ) {
        return failure("RUNNER_OUTBOX_EVENT_INVALID", "Runner semantic event is invalid.");
      }
      const bodyJson = JSON.stringify(body.data);
      const bytes = Buffer.byteLength(bodyJson, "utf8");
      const digest = createHash("sha256").update(bodyJson, "utf8").digest("hex");
      if (bytes < 1 || bytes > 65_536) {
        return failure("RUNNER_OUTBOX_EVENT_INVALID", "Runner semantic event is invalid.");
      }
      const prior = select.get(input.eventId);
      if (prior) {
        return prior.body_digest === digest && prior.body_json === bodyJson
          ? { ok: true, value: parseRow(prior) }
          : failure("RUNNER_EVENT_ID_CONFLICT", "Runner event identifier conflicts.");
      }
      const eventPriority = priority(body.data);
      const totals = database
        .query<{ items: number; bytes: number }, []>(
          "SELECT count(*) AS items, coalesce(sum(byte_count), 0) AS bytes FROM local_semantic_outbox",
        )
        .get();
      const maximumItems =
        eventPriority === "CRITICAL"
          ? limits.maximumItems
          : limits.maximumItems - limits.reservedCriticalItems;
      const maximumBytes =
        eventPriority === "CRITICAL"
          ? limits.maximumBytes
          : limits.maximumBytes - limits.reservedCriticalBytes;
      if ((totals?.items ?? 0) >= maximumItems || (totals?.bytes ?? 0) + bytes > maximumBytes) {
        return failure(
          eventPriority === "CRITICAL" ? "RUNNER_OUTBOX_FULL" : "RUNNER_OUTBOX_RESERVED_CAPACITY",
          "Runner semantic outbox limit was reached.",
          "REFRESH",
        );
      }
      const predecessor = database
        .query<{ event_id: string; local_sequence: number }, [string | null]>(
          `SELECT event_id, local_sequence FROM local_semantic_outbox
           WHERE run_id IS ? ORDER BY local_sequence DESC LIMIT 1`,
        )
        .get(input.runId ?? null);
      const sequence = (predecessor?.local_sequence ?? 0) + 1;
      const now = Math.floor(clock());
      try {
        database
          .query(
            `INSERT INTO local_semantic_outbox(
               event_id, run_id, event_kind, priority, body_digest, body_json, byte_count,
               local_sequence, predecessor_event_id, state, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
          )
          .run(
            input.eventId,
            input.runId ?? null,
            body.data.kind,
            eventPriority,
            digest,
            bodyJson,
            bytes,
            sequence,
            predecessor?.event_id ?? null,
            now,
            now,
          );
        const created = select.get(input.eventId);
        return created
          ? { ok: true, value: parseRow(created) }
          : failure("RUNNER_OUTBOX_STATE_FAILED", "Runner semantic outbox state failed.");
      } catch {
        return failure("RUNNER_OUTBOX_STATE_FAILED", "Runner semantic outbox state failed.");
      }
    },

    ready(): readonly SemanticOutboxEvent[] {
      return database
        .query<Row, []>(
          "SELECT * FROM local_semantic_outbox WHERE state = 'PENDING' ORDER BY local_sequence",
        )
        .all()
        .map(parseRow);
    },

    inspect(eventId: string): Result<SemanticOutboxEvent> {
      const row = select.get(eventId);
      return row
        ? { ok: true, value: parseRow(row) }
        : failure("RUNNER_OUTBOX_EVENT_NOT_FOUND", "Runner semantic event was not found.");
    },

    markInFlight(eventId: string): Result<SemanticOutboxEvent> {
      const changed = database
        .query(
          "UPDATE local_semantic_outbox SET state = 'IN_FLIGHT', updated_at = ? WHERE event_id = ? AND state = 'PENDING'",
        )
        .run(Math.floor(clock()), eventId);
      const row = select.get(eventId);
      return changed.changes === 1 && row
        ? { ok: true, value: parseRow(row) }
        : failure("RUNNER_OUTBOX_STATE_CONFLICT", "Runner semantic event state changed.");
    },

    requeueInFlight(): Result<Readonly<{ requeued: number }>> {
      const changed = database
        .query(
          "UPDATE local_semantic_outbox SET state = 'PENDING', updated_at = ? WHERE state = 'IN_FLIGHT'",
        )
        .run(Math.floor(clock()));
      return { ok: true, value: { requeued: changed.changes } };
    },

    acknowledge(
      eventId: string,
      disposition: "APPLIED" | "DUPLICATE" | "REJECTED",
      rejectionCode?: string,
    ): Result<SemanticOutboxEvent> {
      if (
        (disposition === "REJECTED" && !/^[A-Z][A-Z0-9_]{0,63}$/.test(rejectionCode ?? "")) ||
        (disposition !== "REJECTED" && rejectionCode !== undefined)
      ) {
        return failure("RUNNER_OUTBOX_ACK_INVALID", "Runner semantic acknowledgement is invalid.");
      }
      const target = disposition === "REJECTED" ? "PERMANENTLY_REJECTED" : "ACKNOWLEDGED";
      const changed = database
        .query(
          `UPDATE local_semantic_outbox
           SET state = ?, rejection_code = ?, acknowledged_at = ?, updated_at = ?
           WHERE event_id = ? AND state IN ('PENDING', 'IN_FLIGHT')`,
        )
        .run(target, rejectionCode ?? null, Math.floor(clock()), Math.floor(clock()), eventId);
      const row = select.get(eventId);
      if (!row)
        return failure("RUNNER_OUTBOX_EVENT_NOT_FOUND", "Runner semantic event was not found.");
      if (changed.changes !== 1 && row.state !== target) {
        return failure("RUNNER_OUTBOX_STATE_CONFLICT", "Runner semantic event state changed.");
      }
      return { ok: true, value: parseRow(row) };
    },
  };
}
