import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { RunnerMessageBodySchema } from "../../shared/contracts/protocol.ts";
import type { DurableRunnerEvent, RunnerOutboundStore } from "./wss-client.ts";

type Row = Readonly<{
  event_id: string;
  body_digest: string;
  body_json: string;
  byte_count: number;
}>;

export function createSqliteRunnerOutboundStore(
  database: Database,
  now: () => number = () => Math.floor(Date.now() / 1_000),
): RunnerOutboundStore {
  const load = (): readonly DurableRunnerEvent[] =>
    database
      .query<Row, []>(
        `SELECT event_id, body_digest, body_json, byte_count
         FROM local_semantic_outbox
         ORDER BY created_at, event_id`,
      )
      .all()
      .map((row) => {
        let candidate: unknown;
        try {
          candidate = JSON.parse(row.body_json);
        } catch {
          throw new Error("RUNNER_OUTBOUND_STORE_CORRUPT");
        }
        const body = RunnerMessageBodySchema.safeParse(candidate);
        const actualBytes = Buffer.byteLength(row.body_json, "utf8");
        const actualDigest = createHash("sha256").update(row.body_json, "utf8").digest("hex");
        if (
          !body.success ||
          body.data.kind === "HEARTBEAT" ||
          body.data.kind === "HEADLESS_OUTPUT_CHUNK" ||
          body.data.eventId !== row.event_id ||
          row.body_digest !== actualDigest ||
          row.byte_count !== actualBytes
        ) {
          throw new Error("RUNNER_OUTBOUND_STORE_CORRUPT");
        }
        return { eventId: row.event_id, digest: row.body_digest, body: body.data };
      });

  return {
    load,

    put(event: DurableRunnerEvent): void {
      const body = RunnerMessageBodySchema.safeParse(event.body);
      const bodyJson = JSON.stringify(event.body);
      const byteCount = Buffer.byteLength(bodyJson, "utf8");
      const digest = createHash("sha256").update(bodyJson, "utf8").digest("hex");
      if (
        !body.success ||
        body.data.kind === "HEARTBEAT" ||
        body.data.kind === "HEADLESS_OUTPUT_CHUNK" ||
        body.data.eventId !== event.eventId ||
        digest !== event.digest ||
        byteCount < 1 ||
        byteCount > 65_536
      ) {
        throw new Error("RUNNER_OUTBOUND_EVENT_INVALID");
      }
      const prior = database
        .query<Row, [string]>(
          `SELECT event_id, body_digest, body_json, byte_count
           FROM local_semantic_outbox WHERE event_id = ?`,
        )
        .get(event.eventId);
      if (prior) {
        if (prior.body_digest !== digest || prior.body_json !== bodyJson) {
          throw new Error("RUNNER_EVENT_ID_CONFLICT");
        }
        return;
      }
      const bounds = database
        .query<{ item_count: number; byte_count: number }, []>(
          `SELECT count(*) AS item_count, coalesce(sum(byte_count), 0) AS byte_count
           FROM local_semantic_outbox`,
        )
        .get();
      if (
        (bounds?.item_count ?? 0) >= 1_024 ||
        (bounds?.byte_count ?? 0) + byteCount > 1024 * 1024
      ) {
        throw new Error("RUNNER_OUTBOUND_BACKPRESSURE");
      }
      database
        .query(
          `INSERT INTO local_semantic_outbox(
             event_id, body_digest, body_json, byte_count, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(event.eventId, digest, bodyJson, byteCount, Math.floor(now()));
    },

    remove(eventId: string): void {
      database.query("DELETE FROM local_semantic_outbox WHERE event_id = ?").run(eventId);
    },
  };
}
