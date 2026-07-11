import { describe, expect, test } from "bun:test";
import {
  createBunRunnerControlAdapter,
  createInMemoryRunnerControlAdapter,
  type RunnerControlSocket,
} from "../../src/server/adapters/wss/bun-runner-control.ts";
import { createRunnerChannel } from "../../src/server/adapters/wss/runner-channel.ts";
import type { VerifiedRunnerPrincipal } from "../../src/shared/contracts/actors.ts";
import type { RunnerEnvelope } from "../../src/shared/contracts/protocol.ts";
import { createApp } from "../../src/server/app.ts";
import { createServerEntrypoint } from "../../src/server/index.ts";
import productionServer from "../../src/server/index.ts";

const principal = {
  kind: "VERIFIED_RUNNER",
  runnerId: "runner_1",
  runnerEpoch: 1,
  ownerMemberId: "member_1",
  keyThumbprint: "thumbprint_1",
  accessExpiresAt: 2_000,
} as unknown as VerifiedRunnerPrincipal;

class FakeSocket implements RunnerControlSocket {
  readonly sent: string[] = [];
  readonly closes: Array<readonly [number, string]> = [];
  data: unknown;
  buffered = 0;
  sendStatus: number | undefined;
  constructor(data: unknown) {
    this.data = data;
  }
  send(value: string): number {
    this.sent.push(value);
    return this.sendStatus ?? Buffer.byteLength(value, "utf8");
  }
  close(code: number, reason: string): void {
    this.closes.push([code, reason]);
  }
  getBufferedAmount(): number {
    return this.buffered;
  }
}

class FakeScheduler {
  now = 1_000;
  #next = 0;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout = (callback: () => void, milliseconds: number): number => {
    const id = ++this.#next;
    this.#timers.set(id, { at: this.now + milliseconds / 1_000, callback });
    return id;
  };
  clearTimeout = (id: unknown): void => {
    this.#timers.delete(Number(id));
  };
  advance(seconds: number): void {
    this.now += seconds;
    for (const [id, timer] of [...this.#timers]) {
      if (timer.at <= this.now) {
        this.#timers.delete(id);
        timer.callback();
      }
    }
  }
}

function heartbeat(sequence = 1): RunnerEnvelope {
  return {
    protocolVersion: "1.0",
    messageId: `message_${sequence}`,
    sequence,
    issuedAt: 1_000,
    expiresAt: 1_010,
    body: { kind: "HEARTBEAT" },
  };
}

function dependencies(scheduler: FakeScheduler, effects: RunnerEnvelope[]) {
  const channel = createRunnerChannel({
    now: () => scheduler.now,
    messageId: () => "server_message_1",
    loadCommitted: () => [],
  });
  return {
    channel,
    now: () => scheduler.now,
    scheduler,
    createRouter: () => ({
      route: async (envelope: RunnerEnvelope) => {
        effects.push(envelope);
        return { accepted: true as const };
      },
    }),
  };
}

async function negotiate(
  socket: FakeSocket,
  receive: (message: string | Uint8Array) => void,
): Promise<void> {
  receive(
    JSON.stringify({
      kind: "CLIENT_HELLO",
      ranges: [{ major: 1, minimumMinor: 0, maximumMinor: 0 }],
    }),
  );
  expect(JSON.parse(socket.sent[0] ?? "null")).toMatchObject({
    kind: "SERVER_WELCOME",
    selectedVersion: "1.0",
  });
}

for (const kind of ["in-memory", "bun"] as const) {
  test(`${kind} runner control adapter shares negotiation, replay, routing, and binary denial`, async () => {
    const scheduler = new FakeScheduler();
    const effects: RunnerEnvelope[] = [];
    const deps = dependencies(scheduler, effects);
    let socket: FakeSocket;
    let receive: (message: string | Uint8Array) => void;
    if (kind === "in-memory") {
      const adapter = createInMemoryRunnerControlAdapter(deps);
      const connection = adapter.connect(principal);
      socket = connection.socket as FakeSocket;
      receive = connection.receive;
    } else {
      let upgradeData: unknown;
      const adapter = createBunRunnerControlAdapter({
        ...deps,
        authority: { authenticateUpgrade: async () => ({ ok: true, value: principal }) },
        secureTransport: () => true,
      });
      const server = {
        upgrade(_request: Request, options: { data: unknown }) {
          upgradeData = options.data;
          return true;
        },
      };
      const response = await adapter.fetch(
        new Request("https://collab.test/runner/v1", {
          headers: {
            authorization: `DPoP ${"a".repeat(48)}`,
            dpop: "proof",
            "dpop-nonce": "nonce_1",
          },
        }),
        server,
      );
      expect(response).toBeUndefined();
      socket = new FakeSocket(upgradeData);
      adapter.websocket.open(socket);
      receive = (message) => adapter.websocket.message(socket, message);
    }

    await negotiate(socket, receive);
    receive(JSON.stringify(heartbeat()));
    receive(JSON.stringify(heartbeat()));
    await Promise.resolve();
    await Promise.resolve();
    expect(effects).toHaveLength(1);
    receive(new Uint8Array([1, 2, 3]));
    expect(socket.closes).toEqual([[1002, "BINARY_FRAME_DENIED"]]);
  });
}

describe("Bun runner control adapter", () => {
  test("the default production export mounts the fail-closed runner upgrade path", async () => {
    expect(productionServer).toHaveProperty("websocket");
    const response = await productionServer.fetch(new Request("https://collab.test/runner/v1"), {
      upgrade: () => true,
    } as never);
    expect(response?.status).toBe(401);
  });

  test("the server entrypoint composes runner upgrades before the Hono fallback", async () => {
    const calls: string[] = [];
    const websocket = { message: () => undefined };
    const entrypoint = createServerEntrypoint({
      app: createApp(),
      runnerControl: {
        fetch: async (request: Request) => {
          calls.push(new URL(request.url).pathname);
          return new URL(request.url).pathname === "/runner/v1"
            ? new Response("upgrade", { status: 401 })
            : null;
        },
        websocket,
      },
      hostname: "127.0.0.1",
      port: 3000,
    });
    expect((await entrypoint.fetch(new Request("https://collab.test/runner/v1"), {}))?.status).toBe(
      401,
    );
    expect((await entrypoint.fetch(new Request("https://collab.test/healthz"), {}))?.status).toBe(
      200,
    );
    expect(entrypoint.websocket).toBe(websocket);
    expect(calls).toEqual(["/runner/v1", "/healthz"]);
  });

  test("authenticates before upgrade and never upgrades failed authentication", async () => {
    const scheduler = new FakeScheduler();
    const effects: RunnerEnvelope[] = [];
    let authenticated = 0;
    let upgrades = 0;
    const adapter = createBunRunnerControlAdapter({
      ...dependencies(scheduler, effects),
      authority: {
        authenticateUpgrade: async () => {
          authenticated += 1;
          return {
            ok: false,
            error: { code: "DENIED", message: "Denied.", retry: "NEVER" },
          };
        },
      },
      secureTransport: () => true,
    });
    const response = await adapter.fetch(
      new Request("https://collab.test/runner/v1", {
        headers: {
          authorization: `DPoP ${"a".repeat(48)}`,
          dpop: "proof",
          "dpop-nonce": "nonce_1",
        },
      }),
      { upgrade: () => ++upgrades > 0 },
    );
    expect(response?.status).toBe(401);
    expect({ authenticated, upgrades }).toEqual({ authenticated: 1, upgrades: 0 });
  });

  test("enforces hello and heartbeat timers and quiesces sockets with 1012", async () => {
    const scheduler = new FakeScheduler();
    const effects: RunnerEnvelope[] = [];
    const adapter = createInMemoryRunnerControlAdapter(dependencies(scheduler, effects));
    const helloTimeout = adapter.connect(principal);
    scheduler.advance(10);
    expect((helloTimeout.socket as FakeSocket).closes).toEqual([[1008, "CLIENT_HELLO_TIMEOUT"]]);

    const active = adapter.connect(principal);
    await negotiate(active.socket as FakeSocket, active.receive);
    scheduler.advance(29);
    expect((active.socket as FakeSocket).closes).toEqual([]);
    active.receive(JSON.stringify({ ...heartbeat(1), issuedAt: 1_039, expiresAt: 1_049 }));
    scheduler.advance(29);
    expect((active.socket as FakeSocket).closes).toEqual([]);
    scheduler.advance(1);
    expect((active.socket as FakeSocket).closes).toEqual([[1008, "RUNNER_HEARTBEAT_TIMEOUT"]]);

    const quiesced = adapter.connect(principal);
    await adapter.quiesce(scheduler.now);
    expect((quiesced.socket as FakeSocket).closes).toEqual([[1012, "SERVICE_RESTART"]]);
    expect(() => adapter.connect(principal)).toThrow("RUNNER_UPGRADES_QUIESCED");
  });

  test("maps Bun dropped and already-enqueued send statuses without false delivery or resend", async () => {
    const scheduler = new FakeScheduler();
    const effects: RunnerEnvelope[] = [];
    const deps = dependencies(scheduler, effects);
    const adapter = createBunRunnerControlAdapter({
      ...deps,
      authority: { authenticateUpgrade: async () => ({ ok: true, value: principal }) },
      secureTransport: () => true,
    });
    const socket = new FakeSocket({ principal });
    adapter.websocket.open(socket);
    await negotiate(socket, (message) => adapter.websocket.message(socket, message));
    const operation = {
      outboxId: "outbox_1",
      runnerId: "runner_1",
      deliveryId: "delivery_1",
      semanticDigest: "a".repeat(64),
      expiresAt: 1_100,
      body: {
        kind: "CANCEL_ATTEMPT",
        deliveryId: "delivery_1",
        semanticDigest: "a".repeat(64),
        attemptId: "attempt_1",
        reason: "CANCELLATION",
      },
    } as const;
    const droppedChannel = createRunnerChannel({
      now: () => scheduler.now,
      messageId: () => "server_message_drop",
      loadCommitted: () => [operation],
    });
    const droppedAdapter = createBunRunnerControlAdapter({
      ...deps,
      channel: droppedChannel,
      authority: { authenticateUpgrade: async () => ({ ok: true, value: principal }) },
      secureTransport: () => true,
    });
    const dropped = new FakeSocket({ principal });
    droppedAdapter.websocket.open(dropped);
    await negotiate(dropped, (message) => droppedAdapter.websocket.message(dropped, message));
    dropped.sendStatus = 0;
    expect(await droppedChannel.dispatchCommitted(["outbox_1"])).toMatchObject([
      { state: "UNREACHABLE" },
    ]);
    expect(droppedChannel.queuedEnvelopeCount("runner_1")).toBe(0);

    socket.sendStatus = -1;
    expect(await deps.channel.dispatchCommitted(["outbox_1"])).toEqual([
      { outboxId: "outbox_1", state: "NOT_COMMITTED" },
    ]);
    const enqueuedChannel = createRunnerChannel({
      now: () => scheduler.now,
      messageId: () => "server_message_enqueued",
      loadCommitted: () => [operation],
    });
    const enqueuedAdapter = createBunRunnerControlAdapter({
      ...deps,
      channel: enqueuedChannel,
      authority: { authenticateUpgrade: async () => ({ ok: true, value: principal }) },
      secureTransport: () => true,
    });
    const enqueued = new FakeSocket({ principal });
    enqueuedAdapter.websocket.open(enqueued);
    await negotiate(enqueued, (message) => enqueuedAdapter.websocket.message(enqueued, message));
    enqueued.sendStatus = -1;
    expect(await enqueuedChannel.dispatchCommitted(["outbox_1"])).toMatchObject([
      { state: "UNREACHABLE" },
    ]);
    expect(enqueuedChannel.queuedEnvelopeCount("runner_1")).toBe(0);
    expect(enqueuedChannel.transportPendingCount("runner_1")).toBe(1);
    enqueued.sendStatus = 1;
    enqueuedAdapter.websocket.drain(enqueued);
    expect(enqueuedChannel.transportPendingCount("runner_1")).toBe(0);
    expect(enqueued.sent.filter((entry) => entry.includes("server_message_enqueued"))).toHaveLength(
      1,
    );
  });
});
