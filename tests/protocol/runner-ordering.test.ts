import { describe, expect, test } from "bun:test";
import { createRunnerChannel } from "../../src/server/adapters/wss/runner-channel.ts";
import type { ServerEnvelope } from "../../src/shared/contracts/protocol.ts";
import { LiveOutputHub } from "../../src/server/adapters/wss/live-output.ts";

const operation = {
  outboxId: "outbox_1",
  runnerId: "runner_1",
  deliveryId: "delivery_1",
  semanticDigest: "a".repeat(64),
  expiresAt: 2_000,
  body: {
    kind: "CANCEL_ATTEMPT",
    deliveryId: "delivery_1",
    semanticDigest: "a".repeat(64),
    attemptId: "attempt_1",
    reason: "CANCELLATION",
  },
} as const;

describe("durable runner delivery", () => {
  test("distinguishes socket send from semantic acknowledgement and resends after reconnect", async () => {
    const sent: ServerEnvelope[] = [];
    let message = 0;
    const channel = createRunnerChannel({
      now: () => 1_000,
      messageId: () => `message_${++message}`,
      loadCommitted: (ids) => ids.map(() => operation),
    });
    const first = channel.attach("runner_1", (envelope) => sent.push(envelope));
    expect(await channel.dispatchCommitted(["outbox_1"])).toEqual([
      { outboxId: "outbox_1", deliveryId: "delivery_1", state: "SOCKET_SENT" },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      messageId: "message_1",
      sequence: 1,
      expiresAt: 1_300,
      body: operation.body,
    });
    expect(channel.pendingDeliveryIds()).toEqual(["delivery_1"]);

    channel.detach("runner_1", first.connectionId, first.fence);
    expect(await channel.dispatchCommitted(["outbox_1"])).toEqual([
      { outboxId: "outbox_1", deliveryId: "delivery_1", state: "UNREACHABLE" },
    ]);
    const reconnected = channel.attach("runner_1", (envelope) => sent.push(envelope));
    expect(reconnected.fence).toBe(first.fence + 1);
    expect(await channel.resendPending("runner_1")).toEqual([
      { outboxId: "outbox_1", deliveryId: "delivery_1", state: "SOCKET_SENT" },
    ]);
    expect(sent[1]).toMatchObject({ messageId: "message_2", sequence: 1, body: operation.body });
    expect(channel.acknowledge("runner_1", "delivery_1", "b".repeat(64))).toEqual({
      accepted: false,
      code: "DELIVERY_DIGEST_CONFLICT",
    });
    expect(channel.acknowledge("runner_1", "delivery_1", "a".repeat(64))).toEqual({
      accepted: true,
      outboxId: "outbox_1",
    });
    expect(channel.pendingDeliveryIds()).toEqual([]);
  });

  test("does not send expired or uncommitted operations and quiesces boundedly", async () => {
    const sent: ServerEnvelope[] = [];
    const channel = createRunnerChannel({
      now: () => 2_000,
      messageId: () => "message_1",
      loadCommitted: (ids) => ids.filter((id) => id === "outbox_1").map(() => operation),
    });
    channel.attach("runner_1", (envelope) => sent.push(envelope));
    expect(await channel.dispatchCommitted(["missing"])).toEqual([
      { outboxId: "missing", state: "NOT_COMMITTED" },
    ]);
    expect(await channel.dispatchCommitted(["outbox_1"])).toEqual([
      { outboxId: "outbox_1", deliveryId: "delivery_1", state: "EXPIRED" },
    ]);
    expect(sent).toEqual([]);
    expect(await channel.quiesce(2_001)).toEqual({ closed: 1, pending: 0 });
    expect(await channel.dispatchCommitted(["outbox_1"])).toEqual([
      { outboxId: "outbox_1", deliveryId: "delivery_1", state: "QUIESCED" },
    ]);
  });

  test("bounds slow-consumer sends and leaves acknowledgement timeouts retryable", async () => {
    let now = 1_000;
    const operations = [1, 2, 3].map((index) => ({
      ...operation,
      outboxId: `outbox_${index}`,
      deliveryId: `delivery_${index}`,
      body: {
        ...operation.body,
        deliveryId: `delivery_${index}`,
      },
    }));
    const channel = createRunnerChannel({
      now: () => now,
      messageId: () => "message_1",
      loadCommitted: (ids) => operations.filter((entry) => ids.includes(entry.outboxId)),
      maximumSendQueueItems: 2,
      maximumSendQueueBytes: 65_536,
    });
    channel.attach("runner_1", () => false);
    expect(await channel.dispatchCommitted(["outbox_1", "outbox_2", "outbox_3"])).toEqual([
      { outboxId: "outbox_1", deliveryId: "delivery_1", state: "UNREACHABLE" },
      { outboxId: "outbox_2", deliveryId: "delivery_2", state: "UNREACHABLE" },
      { outboxId: "outbox_3", deliveryId: "delivery_3", state: "UNREACHABLE" },
    ]);
    expect(channel.queuedEnvelopeCount("runner_1")).toBe(2);

    expect(channel.sweepAcknowledgementTimeouts()).toEqual([]);
    expect(channel.pendingDeliveryIds()).toEqual(["delivery_1", "delivery_2", "delivery_3"]);

    const acknowledged = createRunnerChannel({
      now: () => now,
      messageId: () => "message_ack",
      loadCommitted: () => operations.slice(0, 1),
    });
    acknowledged.attach("runner_1", () => true);
    expect(await acknowledged.dispatchCommitted(["outbox_1"])).toMatchObject([
      { state: "SOCKET_SENT" },
    ]);
    now = 1_009;
    expect(acknowledged.sweepAcknowledgementTimeouts()).toEqual([]);
    now = 1_010;
    expect(acknowledged.sweepAcknowledgementTimeouts()).toEqual(["delivery_1"]);
    expect(acknowledged.pendingDeliveryIds()).toEqual(["delivery_1"]);
    expect(acknowledged.sweepAcknowledgementTimeouts()).toEqual([]);
  });

  test("schedules semantic acknowledgement expiry and quiesces timers, queues, and live output", async () => {
    let now = 1_000;
    let scheduled: (() => void) | undefined;
    const cancelled: unknown[] = [];
    const dispositions: Array<readonly [string, string]> = [];
    const output = new LiveOutputHub();
    output.activate("ATTEMPT", "attempt_1", "HEADLESS");
    output.accept("ATTEMPT", "attempt_1", "STDOUT", 1, "safe", 1, false);
    const channel = createRunnerChannel({
      now: () => now,
      messageId: () => "message_1",
      loadCommitted: () => [operation],
      liveOutput: output,
      scheduleTimeout(callback, milliseconds) {
        expect(milliseconds).toBe(10_000);
        scheduled = callback;
        return "timer_1";
      },
      clearTimeout(handle) {
        cancelled.push(handle);
      },
      onAcknowledgementTimeout(deliveryId, reason) {
        dispositions.push([deliveryId, reason]);
      },
    });
    channel.attach("runner_1", () => true);
    expect(await channel.dispatchCommitted(["outbox_1"])).toMatchObject([{ state: "SOCKET_SENT" }]);
    now = 1_010;
    scheduled?.();
    expect(dispositions).toEqual([["delivery_1", "TIMEOUT"]]);
    expect(channel.pendingDeliveryIds()).toEqual(["delivery_1"]);
    expect(await channel.quiesce(1_010)).toEqual({ closed: 1, pending: 1 });
    expect(cancelled).toEqual(["timer_1"]);
    expect(output.inspect("ATTEMPT", "attempt_1")).toEqual([]);
  });

  test("drains queued sends only until the supplied quiesce deadline", async () => {
    let now = 1_000;
    let writable = false;
    let waits = 0;
    let sends = 0;
    const channel = createRunnerChannel({
      now: () => now,
      messageId: () => "message_1",
      loadCommitted: () => [operation],
      async waitForDrain(deadline) {
        waits += 1;
        expect(deadline).toBe(1_005);
        now = 1_003;
        writable = true;
      },
    });
    channel.attach("runner_1", () => {
      sends += 1;
      return writable;
    });
    expect(await channel.dispatchCommitted(["outbox_1"])).toMatchObject([{ state: "UNREACHABLE" }]);
    expect(channel.queuedEnvelopeCount("runner_1")).toBe(1);
    expect(await channel.quiesce(1_005)).toEqual({ closed: 1, pending: 1 });
    expect({ waits, sends }).toEqual({ waits: 1, sends: 3 });
    expect(channel.queuedEnvelopeCount("runner_1")).toBe(0);

    now = 2_000;
    let deadlineWaits = 0;
    const expired = createRunnerChannel({
      now: () => now,
      messageId: () => "message_2",
      loadCommitted: () => [operation],
      waitForDrain: async () => {
        deadlineWaits += 1;
      },
    });
    expired.attach("runner_1", () => false);
    await expired.dispatchCommitted(["outbox_1"]);
    await expired.quiesce(2_000);
    expect(deadlineWaits).toBe(0);
  });
});
