import { describe, expect, test } from "bun:test";
import { createRunnerChannel } from "../../src/server/adapters/wss/runner-channel.ts";
import type { ServerEnvelope } from "../../src/shared/contracts/protocol.ts";

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
    expect(sent[0]).toMatchObject({ messageId: "message_1", sequence: 1, body: operation.body });
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
});
