import type { Database } from "bun:sqlite";
import { createRunnerSemanticOutbox } from "../outbox.ts";
import type { DurableRunnerEvent, RunnerOutboundStore } from "./wss-client.ts";

function runId(event: DurableRunnerEvent): string | undefined {
  const body = event.body;
  return "payload" in body && "runId" in body.payload && typeof body.payload.runId === "string"
    ? body.payload.runId
    : undefined;
}

export function createSqliteRunnerOutboundStore(
  database: Database,
  now: () => number = () => Math.floor(Date.now() / 1_000),
): RunnerOutboundStore {
  const outbox = createRunnerSemanticOutbox(database, now);
  const restored = outbox.requeueInFlight();
  if (!restored.ok) throw new Error("RUNNER_OUTBOUND_STORE_CORRUPT");
  return {
    load: () =>
      outbox.ready().map((event) => ({
        eventId: event.eventId,
        digest: event.digest,
        body: event.body,
        localSequence: event.localSequence,
        ...(event.predecessorEventId ? { predecessorEventId: event.predecessorEventId } : {}),
      })),

    put(event) {
      const persisted = outbox.enqueue({
        eventId: event.eventId,
        ...(runId(event) ? { runId: runId(event) } : {}),
        body: event.body,
      });
      if (!persisted.ok) throw new Error(persisted.error.code);
      if (persisted.value.digest !== event.digest) throw new Error("RUNNER_EVENT_ID_CONFLICT");
      return {
        eventId: persisted.value.eventId,
        digest: persisted.value.digest,
        body: persisted.value.body,
        localSequence: persisted.value.localSequence,
        ...(persisted.value.predecessorEventId
          ? { predecessorEventId: persisted.value.predecessorEventId }
          : {}),
      };
    },

    markInFlight(eventId): void {
      const result = outbox.markInFlight(eventId);
      if (!result.ok && result.error.code !== "RUNNER_OUTBOX_STATE_CONFLICT") {
        throw new Error(result.error.code);
      }
    },

    remove(eventId): void {
      const result = outbox.acknowledge(eventId, "APPLIED");
      if (!result.ok) throw new Error(result.error.code);
    },

    reject(eventId): void {
      const result = outbox.acknowledge(eventId, "REJECTED", "SERVER_REJECTED");
      if (!result.ok) throw new Error(result.error.code);
    },
  };
}
