import { describe, expect, test } from "bun:test";
import {
  createRunnerWssClient,
  type DurableRunnerEvent,
  type RunnerOutboundStore,
} from "../../src/runner/transport/wss-client.ts";
import type { ServerEnvelope } from "../../src/shared/contracts/protocol.ts";

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];
  readonly closes: Array<readonly [number, string]> = [];
  bufferedAmount = 0;
  send(value: string): void {
    this.sent.push(value);
  }
  close(code: number, reason: string): void {
    this.closes.push([code, reason]);
  }
}

class FakeOutboundStore implements RunnerOutboundStore {
  readonly entries = new Map<string, DurableRunnerEvent>();
  readonly removals: string[] = [];

  load(): readonly DurableRunnerEvent[] {
    return [...this.entries.values()];
  }

  put(event: DurableRunnerEvent): void {
    this.entries.set(event.eventId, event);
  }

  remove(messageId: string): void {
    this.removals.push(messageId);
    this.entries.delete(messageId);
  }
}

const effectiveLimits = {
  maximumFrameBytes: 65_536,
  runnerFramesPerSecond: 100,
  runnerBurst: 200,
  runFramesPerSecond: 50,
  runBurst: 100,
  sendQueueItems: 1_024,
  sendQueueBytes: 1024 * 1024,
  heartbeatSeconds: 10,
  offlineSeconds: 30,
  operationAckSeconds: 10,
  outputChunkBytes: 16 * 1024,
  reconnectBufferBytes: 1024 * 1024,
  reconnectBackoffSeconds: 30,
} as const;

const welcome = {
  kind: "SERVER_WELCOME",
  selectedVersion: "1.0",
  connectionId: "connection_1",
  fence: 1,
  limits: effectiveLimits,
} as const;

function envelope(overrides: Partial<ServerEnvelope> = {}): ServerEnvelope {
  return {
    protocolVersion: "1.0",
    messageId: "message_1",
    sequence: 1,
    issuedAt: 990,
    expiresAt: 1_010,
    body: { kind: "HEARTBEAT_ACK", receivedAt: 1_000, nextHeartbeatAt: 1_010 },
    ...overrides,
  };
}

async function activeClient(onEnvelope: (value: ServerEnvelope) => Promise<void>) {
  const socket = new FakeSocket();
  const client = createRunnerWssClient({
    endpoint: "wss://collab.test/runner/v1",
    issueAccess: async () => ({
      accessToken: "a".repeat(48),
      proof: "signed-proof",
      nonce: "nonce_1",
    }),
    socketFactory: () => socket,
    supportedRanges: [{ major: 1, minimumMinor: 0, maximumMinor: 0 }],
    onEnvelope,
    outboundStore: new FakeOutboundStore(),
    now: () => 1_000,
  });
  await client.start();
  socket.dispatchEvent(new Event("open"));
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(welcome) }));
  expect(client.state).toBe("ACTIVE");
  return { client, socket };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("runner WSS client", () => {
  test("uses Bun custom headers and negotiates before becoming active", async () => {
    const socket = new FakeSocket();
    const calls: unknown[] = [];
    const client = createRunnerWssClient({
      endpoint: "wss://collab.test/runner/v1",
      issueAccess: async () => ({
        accessToken: "a".repeat(48),
        proof: "signed-proof",
        nonce: "nonce_1",
      }),
      socketFactory(url, options) {
        calls.push({ url, options });
        return socket;
      },
      supportedRanges: [{ major: 1, minimumMinor: 0, maximumMinor: 1 }],
      onEnvelope: async () => undefined,
      outboundStore: new FakeOutboundStore(),
    });
    await client.start();
    expect(calls).toEqual([
      {
        url: "wss://collab.test/runner/v1",
        options: {
          headers: {
            authorization: `DPoP ${"a".repeat(48)}`,
            dpop: "signed-proof",
            "dpop-nonce": "nonce_1",
          },
        },
      },
    ]);
    socket.dispatchEvent(new Event("open"));
    expect(JSON.parse(socket.sent[0] ?? "null")).toEqual({
      kind: "CLIENT_HELLO",
      ranges: [{ major: 1, minimumMinor: 0, maximumMinor: 1 }],
    });
    expect(client.state).toBe("NEGOTIATING");
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          kind: "SERVER_WELCOME",
          selectedVersion: "1.1",
          connectionId: "connection_1",
          fence: 1,
          limits: effectiveLimits,
        }),
      }),
    );
    expect(client.state).toBe("ACTIVE");
    client.stop();
    socket.dispatchEvent(new CloseEvent("close"));
    expect(client.state).toBe("STOPPED");
  });

  test("rejects insecure or decorated endpoints before obtaining credentials", async () => {
    for (const endpoint of [
      "ws://collab.test/runner/v1",
      "wss://collab.test/runner/v1?token=x",
      "wss://user@collab.test/runner/v1",
      "wss://collab.test/other",
    ]) {
      let issued = 0;
      const client = createRunnerWssClient({
        endpoint,
        issueAccess: async () => {
          issued += 1;
          return { accessToken: "a".repeat(48), proof: "proof", nonce: "nonce" };
        },
        socketFactory: () => new FakeSocket(),
        supportedRanges: [{ major: 1, minimumMinor: 0, maximumMinor: 0 }],
        onEnvelope: async () => undefined,
        outboundStore: new FakeOutboundStore(),
      });
      expect(client.start()).rejects.toThrow("RUNNER_WSS_ENDPOINT_INVALID");
      expect(issued).toBe(0);
    }
  });

  test("rejects stale, excessive-lifetime, and future server envelopes before effects", async () => {
    for (const candidate of [
      envelope({ messageId: "stale_1", issuedAt: 900, expiresAt: 1_000 }),
      envelope({ messageId: "future_1", issuedAt: 1_031, expiresAt: 1_040 }),
      envelope({ messageId: "long_1", issuedAt: 1_000, expiresAt: 1_301 }),
    ]) {
      const accepted: ServerEnvelope[] = [];
      const { socket } = await activeClient(async (value) => {
        accepted.push(value);
      });
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(candidate) }));
      await settle();
      expect(accepted).toEqual([]);
      expect(socket.closes).toEqual([[1002, "PROTOCOL_ERROR"]]);
    }
  });

  test("stops without reconnecting after a permanent protocol failure", async () => {
    const socket = new FakeSocket();
    let reconnects = 0;
    const client = createRunnerWssClient({
      endpoint: "wss://collab.test/runner/v1",
      issueAccess: async () => ({
        accessToken: "a".repeat(48),
        proof: "signed-proof",
        nonce: "nonce_1",
      }),
      socketFactory: () => socket,
      supportedRanges: [{ major: 1, minimumMinor: 0, maximumMinor: 0 }],
      outboundStore: new FakeOutboundStore(),
      onEnvelope: async () => undefined,
      scheduleReconnect() {
        reconnects += 1;
        return reconnects;
      },
    });
    await client.start();
    socket.dispatchEvent(new Event("open"));
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(welcome) }));
    socket.dispatchEvent(new MessageEvent("message", { data: "{}" }));
    socket.dispatchEvent(new CloseEvent("close"));
    expect(client.state).toBe("STOPPED");
    expect(reconnects).toBe(0);
  });

  test("deduplicates exact server replay and closes sequence or changed-id replay", async () => {
    const accepted: string[] = [];
    const { socket } = await activeClient(async (value) => {
      accepted.push(value.messageId);
    });
    const first = envelope();
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(first) }));
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(first) }));
    await settle();
    expect(accepted).toEqual(["message_1"]);
    expect(socket.closes).toEqual([]);

    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(envelope({ messageId: "message_2", sequence: 1 })),
      }),
    );
    await settle();
    expect(socket.closes).toEqual([[1002, "PROTOCOL_ERROR"]]);

    const changed = await activeClient(async () => undefined);
    changed.socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(first) }));
    changed.socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(
          envelope({
            body: { kind: "HEARTBEAT_ACK", receivedAt: 1_001, nextHeartbeatAt: 1_011 },
          }),
        ),
      }),
    );
    await settle();
    expect(changed.socket.closes).toEqual([[1002, "PROTOCOL_ERROR"]]);
  });

  test("serializes asynchronous server envelope effects in connection order", async () => {
    let releaseFirst: (() => void) | undefined;
    const order: string[] = [];
    const { socket } = await activeClient(async (value) => {
      order.push(`start:${value.messageId}`);
      if (value.messageId === "message_1") {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      order.push(`end:${value.messageId}`);
    });
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(envelope()) }));
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(envelope({ messageId: "message_2", sequence: 2 })),
      }),
    );
    await settle();
    expect(order).toEqual(["start:message_1"]);
    releaseFirst?.();
    await settle();
    await settle();
    expect(order).toEqual(["start:message_1", "end:message_1", "start:message_2", "end:message_2"]);
  });

  test("owns bounded ordered outbound runner envelopes only while active", async () => {
    const socket = new FakeSocket();
    const client = createRunnerWssClient({
      endpoint: "wss://collab.test/runner/v1",
      issueAccess: async () => ({
        accessToken: "a".repeat(48),
        proof: "signed-proof",
        nonce: "nonce_1",
      }),
      socketFactory: () => socket,
      supportedRanges: [{ major: 1, minimumMinor: 0, maximumMinor: 0 }],
      onEnvelope: async () => undefined,
      outboundStore: new FakeOutboundStore(),
      now: () => 1_000,
      messageId: (() => {
        let id = 0;
        return () => `runner_message_${++id}`;
      })(),
      maximumOutboundItems: 2,
      maximumOutboundBytes: 1_024,
    });
    expect(client.send({ kind: "HEARTBEAT" })).toMatchObject({
      ok: false,
      error: { code: "RUNNER_CONNECTION_INACTIVE" },
    });
    await client.start();
    socket.dispatchEvent(new Event("open"));
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(welcome) }));
    socket.bufferedAmount = 1024 * 1024;
    expect(client.send({ kind: "HEARTBEAT" })).toMatchObject({ ok: true, value: { queued: true } });
    expect(
      client.send({
        kind: "OPERATION_ACKNOWLEDGEMENT",
        eventId: "event_1",
        deliveryId: "delivery_1",
        semanticDigest: "a".repeat(64),
      }),
    ).toMatchObject({ ok: true, value: { queued: true } });
    expect(client.send({ kind: "HEARTBEAT" })).toMatchObject({
      ok: false,
      error: { code: "RUNNER_OUTBOUND_BACKPRESSURE" },
    });
    socket.bufferedAmount = 0;
    expect(client.flushOutbound()).toBe(2);
    const envelopes = socket.sent.slice(1).map((entry) => JSON.parse(entry));
    expect(envelopes).toMatchObject([
      { messageId: "runner_message_1", sequence: 1, body: { kind: "HEARTBEAT" } },
      {
        messageId: "runner_message_2",
        sequence: 2,
        body: {
          kind: "OPERATION_ACKNOWLEDGEMENT",
          eventId: "event_1",
          deliveryId: "delivery_1",
        },
      },
    ]);
  });

  test("schedules backpressure drain and replays durable events with stable semantic identity", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const store = new FakeOutboundStore();
    const scheduled: Array<() => void> = [];
    let reconnectCallback: (() => void) | undefined;
    let reconnectMilliseconds = 0;
    let socketIndex = 0;
    const client = createRunnerWssClient({
      endpoint: "wss://collab.test/runner/v1",
      issueAccess: async () => ({
        accessToken: "a".repeat(48),
        proof: "signed-proof",
        nonce: "nonce_1",
      }),
      socketFactory: () => sockets[socketIndex++] ?? new FakeSocket(),
      supportedRanges: [{ major: 1, minimumMinor: 0, maximumMinor: 0 }],
      onEnvelope: async () => undefined,
      now: () => 1_000,
      messageId: (() => {
        let id = 0;
        return () => `runner_message_${++id}`;
      })(),
      outboundStore: store,
      scheduleDrain(callback) {
        scheduled.push(callback);
        return callback;
      },
      clearDrain(handle) {
        const index = scheduled.indexOf(handle as () => void);
        if (index >= 0) scheduled.splice(index, 1);
      },
      reconnectJitter: () => 1,
      scheduleReconnect(callback, milliseconds) {
        reconnectCallback = callback;
        reconnectMilliseconds = milliseconds;
        return callback;
      },
      clearReconnect(handle) {
        if (reconnectCallback === handle) reconnectCallback = undefined;
      },
    });

    await client.start();
    sockets[0]?.dispatchEvent(new Event("open"));
    sockets[0]?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(welcome) }));
    if (!sockets[0]) throw new Error("missing socket");
    sockets[0].bufferedAmount = 1024 * 1024;
    expect(
      client.send({
        kind: "OPERATION_ACKNOWLEDGEMENT",
        eventId: "event_1",
        deliveryId: "delivery_1",
        semanticDigest: "a".repeat(64),
      }),
    ).toMatchObject({ ok: true, value: { queued: true } });
    expect(
      client.send({
        kind: "OPERATION_ACKNOWLEDGEMENT",
        eventId: "event_1",
        deliveryId: "delivery_changed",
        semanticDigest: "b".repeat(64),
      }),
    ).toMatchObject({ ok: false, error: { code: "RUNNER_EVENT_ID_CONFLICT" } });
    expect(client.send({ kind: "HEARTBEAT" })).toMatchObject({
      ok: true,
      value: { queued: true },
    });
    expect(scheduled).toHaveLength(1);
    expect(store.entries.size).toBe(1);

    sockets[0].bufferedAmount = 0;
    scheduled.shift()?.();
    const firstWire = sockets[0].sent.slice(1).map((entry) => JSON.parse(entry));
    expect(firstWire).toMatchObject([
      { messageId: "runner_message_1", sequence: 1, body: { eventId: "event_1" } },
      { messageId: "runner_message_2", sequence: 2, body: { kind: "HEARTBEAT" } },
    ]);

    sockets[0].dispatchEvent(new CloseEvent("close"));
    expect(client.state).toBe("BACKING_OFF");
    expect(reconnectMilliseconds).toBe(1_000);
    reconnectCallback?.();
    await settle();
    sockets[1]?.dispatchEvent(new Event("open"));
    sockets[1]?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(welcome) }));
    const replay = JSON.parse(sockets[1]?.sent[1] ?? "null");
    expect(replay).toMatchObject({
      messageId: "runner_message_3",
      sequence: 1,
      body: { eventId: "event_1" },
    });
    expect(sockets[1]?.sent).toHaveLength(2);

    sockets[1]?.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(
          envelope({
            messageId: "server_ack_1",
            body: {
              kind: "SEMANTIC_EVENT_ACK",
              eventId: "event_1",
              disposition: "APPLIED",
            },
          }),
        ),
      }),
    );
    await settle();
    expect(store.entries.size).toBe(0);
    expect(store.removals).toEqual(["event_1"]);
  });

  test("quiesce is bounded and preserves unacknowledged durable messages", async () => {
    const socket = new FakeSocket();
    const store = new FakeOutboundStore();
    let now = 1_000;
    const client = createRunnerWssClient({
      endpoint: "wss://collab.test/runner/v1",
      issueAccess: async () => ({
        accessToken: "a".repeat(48),
        proof: "signed-proof",
        nonce: "nonce_1",
      }),
      socketFactory: () => socket,
      supportedRanges: [{ major: 1, minimumMinor: 0, maximumMinor: 0 }],
      onEnvelope: async () => undefined,
      now: () => now,
      messageId: () => "runner_message_1",
      outboundStore: store,
      waitForDrain: async () => {
        now = 1_001;
      },
    });
    await client.start();
    socket.dispatchEvent(new Event("open"));
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(welcome) }));
    socket.bufferedAmount = 1024 * 1024;
    client.send({
      kind: "OPERATION_ACKNOWLEDGEMENT",
      eventId: "event_1",
      deliveryId: "delivery_1",
      semanticDigest: "a".repeat(64),
    });

    expect(await client.quiesce(1_001)).toEqual({ closed: 1, pending: 1 });
    expect(client.state).toBe("STOPPED");
    expect(store.entries.size).toBe(1);
  });

  test("retains authority requests until the correlated response effect and ACK complete", async () => {
    const socket = new FakeSocket();
    const store = new FakeOutboundStore();
    let releaseResponse: (() => void) | undefined;
    const client = createRunnerWssClient({
      endpoint: "wss://collab.test/runner/v1",
      issueAccess: async () => ({
        accessToken: "a".repeat(48),
        proof: "signed-proof",
        nonce: "nonce_1",
      }),
      socketFactory: () => socket,
      supportedRanges: [{ major: 1, minimumMinor: 0, maximumMinor: 0 }],
      outboundStore: store,
      now: () => 1_000,
      messageId: () => "runner_message_1",
      onEnvelope: async (value) => {
        if (value.body.kind === "AUTHORITY_RESPONSE") {
          await new Promise<void>((resolve) => {
            releaseResponse = resolve;
          });
        }
      },
    });
    await client.start();
    socket.dispatchEvent(new Event("open"));
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(welcome) }));
    expect(
      client.send({
        kind: "CONSUME_DISPATCH_PERMIT",
        eventId: "event_1",
        requestId: "request_1",
        payload: { permit: "permit_1" },
      }),
    ).toMatchObject({ ok: true });
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(
          envelope({
            messageId: "response_1",
            sequence: 1,
            body: {
              kind: "AUTHORITY_RESPONSE",
              requestId: "request_1",
              result: {
                kind: "CONSUME_PERMIT",
                session: {
                  id: "session_1",
                  attemptId: "attempt_1",
                  fence: 1,
                  issuedAt: 1_000,
                  expiresAt: 1_010,
                  repositoryAssurance: "ADVISORY",
                  connectorEpochs: {},
                  repositoryMode: "INSPECT_ONLY",
                },
              },
            },
          }),
        ),
      }),
    );
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(
          envelope({
            messageId: "ack_1",
            sequence: 2,
            body: { kind: "SEMANTIC_EVENT_ACK", eventId: "event_1", disposition: "APPLIED" },
          }),
        ),
      }),
    );
    await settle();
    expect(store.entries.size).toBe(1);
    releaseResponse?.();
    await settle();
    await settle();
    expect(store.entries.size).toBe(0);
  });
});
