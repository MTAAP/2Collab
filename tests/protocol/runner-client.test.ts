import { describe, expect, test } from "bun:test";
import { createRunnerWssClient } from "../../src/runner/transport/wss-client.ts";
import type { ServerEnvelope } from "../../src/shared/contracts/protocol.ts";

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];
  readonly closes: Array<readonly [number, string]> = [];
  send(value: string): void {
    this.sent.push(value);
  }
  close(code: number, reason: string): void {
    this.closes.push([code, reason]);
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
});
