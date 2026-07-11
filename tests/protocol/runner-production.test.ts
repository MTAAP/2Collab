import { expect, test } from "bun:test";
import { createNativeExecutionHost } from "../../src/runner/adapters/host/native.ts";
import { createCodexExecutionAdapter } from "../../src/runner/adapters/runtime/codex.ts";
import { createRunnerSupervisor } from "../../src/runner/supervisor.ts";
import {
  createRunnerWssClient,
  type DurableRunnerEvent,
  type RunnerClientSocket,
} from "../../src/runner/transport/wss-client.ts";
import type { RunnerControlSocket } from "../../src/server/adapters/wss/bun-runner-control.ts";
import { LiveOutputHub } from "../../src/server/adapters/wss/live-output.ts";
import { createProductionRunnerServer } from "../../src/server/adapters/wss/production.ts";
import { createApp } from "../../src/server/app.ts";
import type { VerifiedRunnerPrincipal } from "../../src/shared/contracts/actors.ts";
import type { ServerEnvelope } from "../../src/shared/contracts/protocol.ts";

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const principal = {
  kind: "VERIFIED_RUNNER",
  runnerId: "runner_1",
  runnerEpoch: 1,
  ownerMemberId: "member_1",
  keyThumbprint: "thumbprint_1",
  accessExpiresAt: 2_000,
} as unknown as VerifiedRunnerPrincipal;

const profile = {
  adapter: "CODEX",
  executable: "/opt/collab/bin/codex",
  fixedArguments: [],
  promptTransport: { headless: "STDIN", interactive: "TERMINAL_INPUT" },
  supportedInteractions: ["HEADLESS"],
  fingerprint: "b".repeat(64),
} as const;

test("production runner data plane dispatches server work and routes redacted host output back", async () => {
  const now = 1_000;
  const output = new LiveOutputHub();
  output.activate("ATTEMPT", "attempt_1", "HEADLESS");
  const heartbeats: string[] = [];
  const semantic: string[] = [];
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
  const server = createProductionRunnerServer({
    app: createApp(),
    hostname: "127.0.0.1",
    port: 3210,
    ports: {
      authentication: { authenticateUpgrade: async () => ({ ok: true, value: principal }) },
      now: () => now,
      messageId: (() => {
        let id = 0;
        return () => `server_message_${++id}`;
      })(),
      secureTransport: () => true,
      loadCommitted: (ids) => (ids.includes("outbox_1") ? [operation] : []),
      heartbeat: async (actor) => {
        heartbeats.push(actor.runnerId);
        return { ok: true, value: { accepted: true } };
      },
      acknowledgeDelivery: () => ({ accepted: true }),
      acceptSemantic: async (body) => {
        semantic.push(body.kind);
        return { ok: true, value: { disposition: "APPLIED" } };
      },
      acceptGateEvent: async () => ({ ok: true, value: { accepted: true } }),
      acceptOutput: (body) =>
        output.accept(
          body.target.kind,
          body.target.kind === "ATTEMPT" ? body.target.attemptId : body.target.gateEvaluationId,
          body.stream,
          body.sequence,
          body.text,
          body.redactionVersion,
          body.truncated,
        ),
    },
  });

  let upgradeData: unknown;
  expect(
    await server.fetch(
      new Request("https://collab.test/runner/v1", {
        headers: {
          authorization: `DPoP ${"x".repeat(48)}`,
          dpop: "proof",
          "dpop-nonce": "nonce_1",
        },
      }),
      {
        upgrade(_request: Request, options: { data: unknown }) {
          upgradeData = options.data;
          return true;
        },
      },
    ),
  ).toBeUndefined();

  let clientSocket: ClientSocket;
  const serverSocket: RunnerControlSocket = {
    data: upgradeData,
    send(value) {
      clientSocket.dispatchEvent(new MessageEvent("message", { data: value }));
      return Buffer.byteLength(value, "utf8");
    },
    close(code, reason) {
      clientSocket.dispatchEvent(new CloseEvent("close", { code, reason }));
    },
    getBufferedAmount: () => 0,
  };
  class ClientSocket extends EventTarget implements RunnerClientSocket {
    readonly bufferedAmount = 0;
    send(value: string): void {
      server.websocket.message(serverSocket, value);
    }
    close(code: number, reason: string): void {
      void code;
      void reason;
      server.websocket.close(serverSocket);
    }
  }
  clientSocket = new ClientSocket();
  let client: ReturnType<typeof createRunnerWssClient>;
  const received: ServerEnvelope[] = [];
  client = createRunnerWssClient({
    endpoint: "wss://collab.test/runner/v1",
    issueAccess: async () => ({ accessToken: "x".repeat(48), proof: "proof", nonce: "nonce_1" }),
    socketFactory: () => clientSocket,
    supportedRanges: [{ major: 1, minimumMinor: 0, maximumMinor: 0 }],
    now: () => now,
    messageId: (() => {
      let id = 0;
      return () => `runner_message_${++id}`;
    })(),
    outboundStore: (() => {
      const events = new Map<string, DurableRunnerEvent>();
      return {
        load: () => [...events.values()],
        put: (event: DurableRunnerEvent) => {
          events.set(event.eventId, event);
        },
        remove: (eventId: string) => {
          events.delete(eventId);
        },
      };
    })(),
    onEnvelope: async (envelope) => {
      received.push(envelope);
      if ("deliveryId" in envelope.body && "semanticDigest" in envelope.body) {
        client.send({
          kind: "OPERATION_ACKNOWLEDGEMENT",
          eventId: "event_delivery_1",
          deliveryId: envelope.body.deliveryId,
          semanticDigest: envelope.body.semanticDigest,
        });
      }
    },
  });
  await client.start();
  server.websocket.open(serverSocket);
  clientSocket.dispatchEvent(new Event("open"));
  expect(client.state).toBe("ACTIVE");

  expect(await server.runnerControl.dispatchCommitted(["outbox_1"])).toMatchObject([
    { state: "SOCKET_SENT" },
  ]);
  await settle();
  expect(received.map((entry) => entry.body.kind)).toEqual([
    "CANCEL_ATTEMPT",
    "SEMANTIC_EVENT_ACK",
  ]);
  expect(server.runnerControl.pendingDeliveryIds()).toEqual([]);
  expect(client.send({ kind: "HEARTBEAT" })).toMatchObject({ ok: true });
  await settle();
  expect(heartbeats).toEqual(["runner_1"]);
  expect(received.at(-1)?.body).toEqual({
    kind: "HEARTBEAT_ACK",
    receivedAt: 1_000,
    nextHeartbeatAt: 1_010,
  });

  const supervisor = createRunnerSupervisor({
    profiles: { resolve: () => ({ ok: true, value: profile }) },
    processes: {
      reserve: () => ({ ok: true, value: { reservationId: "reservation_1", disposition: "NEW" } }),
      release: () => ({ ok: true, value: undefined }),
      recordFailed: () => ({ ok: true, value: undefined }),
      markStarting: () => ({ ok: true, value: undefined }),
      recordStarted: () => ({ ok: true, value: undefined }),
    },
    worktrees: { resolveRunWorktree: async () => ({ ok: true, value: { id: "worktree_1" } }) },
    environment: { build: () => ({ ok: true, value: {} }), validate: () => true },
    enforcement: {
      assurance: "ADVISORY",
      activate: async () => ({ ok: true, value: { sessionId: "enforcement_1" } }),
      inspect: async () => ({ ok: true, value: { state: "ACTIVE", assurance: "ADVISORY" } }),
      revoke: async () => ({ ok: true, value: undefined }),
    },
    permits: { consume: async () => ({ ok: true, value: { consumed: true } }) },
    adapters: { CODEX: createCodexExecutionAdapter() },
    hosts: {
      NATIVE: createNativeExecutionHost({
        start: async (launch) => {
          await launch.headlessOutput?.({ kind: "STDOUT", text: "ghp_aaaaaaaaaa" });
          await launch.headlessOutput?.({ kind: "STDOUT", text: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
          await launch.headlessOutput?.({ kind: "EXIT", exitCode: 0, signal: null });
          return { opaqueProcessId: "process_1" };
        },
        cancel: async () => true,
        inspect: async () => "RUNNING",
        attach: async () => ({ localAttachmentId: "attachment_1" }),
      }),
    },
    clock: () => now,
    output: {
      send: async (body) => {
        const sent = client.send(body);
        if (!sent.ok) throw new Error(sent.error.code);
      },
    },
  });
  expect(
    await supervisor.launch({
      runId: "run_1",
      attemptId: "attempt_1",
      assignmentDigest: "c".repeat(64),
      worktreeKey: "worktree_1",
      profileVersionId: "profile_1",
      expectedProfileFingerprint: profile.fingerprint,
      runtime: "CODEX",
      host: "NATIVE",
      interaction: "HEADLESS",
      assurance: "ADVISORY",
      instructions: "Review",
      maximumRuntimeSeconds: 60,
      deadlineAt: 1_100,
      dispatchPermit: "permit_secret",
    }),
  ).toMatchObject({ ok: true });
  await settle();
  const text = output
    .inspect("ATTEMPT", "attempt_1")
    .map((chunk) => chunk.text)
    .join("");
  expect(text).toContain("[REDACTED_GITHUB_TOKEN]");
  expect(text).not.toContain("ghp_");
  expect(semantic).toEqual([]);
});
