import { createHash, randomBytes } from "node:crypto";
import {
  type ClientHello,
  ClientHelloSchema,
  type RunnerEnvelope,
  RunnerEnvelopeSchema,
  RunnerMessageBodySchema,
  type ServerEnvelope,
  ServerEnvelopeSchema,
  ServerWelcomeSchema,
} from "../../shared/contracts/protocol.ts";
import type { Result } from "../../shared/contracts/result.ts";
import { RunnerReconnectState } from "./reconnect.ts";

type DurableBody = Exclude<
  RunnerEnvelope["body"],
  Readonly<{ kind: "HEARTBEAT" | "HEADLESS_OUTPUT_CHUNK" }>
>;

export type DurableRunnerEvent = Readonly<{
  eventId: string;
  digest: string;
  body: DurableBody;
}>;

export interface RunnerOutboundStore {
  load(): readonly DurableRunnerEvent[];
  put(event: DurableRunnerEvent): void;
  remove(eventId: string): void;
}

export type RunnerClientSocket = EventTarget &
  Readonly<{
    send(value: string): void;
    close(code: number, reason: string): void;
    readonly bufferedAmount?: number;
  }>;

type AccessIssue = Readonly<{ accessToken: string; proof: string; nonce: string }>;
type Dependencies = Readonly<{
  endpoint: string;
  issueAccess: () => Promise<AccessIssue>;
  socketFactory?: (
    url: string,
    options: Readonly<{ headers: Readonly<Record<string, string>> }>,
  ) => RunnerClientSocket;
  supportedRanges: ClientHello["ranges"];
  onEnvelope: (envelope: ServerEnvelope) => Promise<void>;
  now?: () => number;
  messageId?: () => string;
  maximumOutboundItems?: number;
  maximumOutboundBytes?: number;
  outboundStore: RunnerOutboundStore;
  scheduleDrain?: (callback: () => void, milliseconds: number) => unknown;
  clearDrain?: (handle: unknown) => void;
  waitForDrain?: (deadline: number) => Promise<void>;
  reconnectJitter?: () => number;
  scheduleReconnect?: (callback: () => void, milliseconds: number) => unknown;
  clearReconnect?: (handle: unknown) => void;
}>;

const MAXIMUM_FUTURE_SKEW_SECONDS = 30;
const MAXIMUM_SERVER_ENVELOPE_LIFETIME_SECONDS = 5 * 60;
const MAXIMUM_REPLAY_ENTRIES = 32_768;
type Outbound = Readonly<{
  body: RunnerEnvelope["body"];
  bytes: number;
  durable: boolean;
  digest?: string;
}>;

function outboundFailure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "REFRESH" } };
}

function defaultSocketFactory(
  url: string,
  options: Readonly<{ headers: Readonly<Record<string, string>> }>,
): RunnerClientSocket {
  const BunWebSocket = WebSocket as unknown as new (
    endpoint: string,
    clientOptions: Readonly<{ headers: Readonly<Record<string, string>> }>,
  ) => RunnerClientSocket;
  return new BunWebSocket(url, options);
}

function validateEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RUNNER_WSS_ENDPOINT_INVALID");
  }
  if (
    url.protocol !== "wss:" ||
    url.pathname !== "/runner/v1" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.toString() !== value
  ) {
    throw new Error("RUNNER_WSS_ENDPOINT_INVALID");
  }
  return value;
}

function boundedAccess(issue: AccessIssue): boolean {
  return (
    /^[A-Za-z0-9_-]{32,512}$/.test(issue.accessToken) &&
    issue.proof.length >= 1 &&
    issue.proof.length <= 8_192 &&
    issue.nonce.length >= 1 &&
    issue.nonce.length <= 512
  );
}

export function createRunnerWssClient(dependencies: Dependencies) {
  const reconnect = new RunnerReconnectState({ jitter: dependencies.reconnectJitter });
  const socketFactory = dependencies.socketFactory ?? defaultSocketFactory;
  const now = dependencies.now ?? (() => Date.now() / 1_000);
  const messageId =
    dependencies.messageId ?? (() => `runner_message_${randomBytes(24).toString("base64url")}`);
  const maximumOutboundItems = dependencies.maximumOutboundItems ?? 1_024;
  const maximumOutboundBytes = dependencies.maximumOutboundBytes ?? 1024 * 1024;
  const outboundStore = dependencies.outboundStore;
  const scheduleDrain =
    dependencies.scheduleDrain ??
    ((callback: () => void, milliseconds: number) => {
      const handle = setTimeout(callback, milliseconds);
      handle.unref?.();
      return handle;
    });
  const clearDrain =
    dependencies.clearDrain ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const waitForDrain =
    dependencies.waitForDrain ??
    ((deadline: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(25, Math.max(0, deadline - now()) * 1_000));
      }));
  const scheduleReconnect =
    dependencies.scheduleReconnect ??
    ((callback: () => void, milliseconds: number) => {
      const handle = setTimeout(callback, milliseconds);
      handle.unref?.();
      return handle;
    });
  const clearReconnect =
    dependencies.clearReconnect ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  if (
    !Number.isSafeInteger(maximumOutboundItems) ||
    maximumOutboundItems < 1 ||
    !Number.isSafeInteger(maximumOutboundBytes) ||
    maximumOutboundBytes < 1
  ) {
    throw new Error("RUNNER_OUTBOUND_LIMIT_INVALID");
  }
  const hello = ClientHelloSchema.parse({
    kind: "CLIENT_HELLO",
    ranges: dependencies.supportedRanges,
  });
  let socket: RunnerClientSocket | null = null;
  let selectedVersion: string | null = null;
  let lastSequence = 0;
  let failed = false;
  let effects = Promise.resolve();
  const seen = new Map<string, Readonly<{ sequence: number; digest: string }>>();
  const outbound: Outbound[] = [];
  const inFlight = new Map<string, Outbound>();
  const processedResponses = new Set<string>();
  const pendingAcknowledgements = new Set<string>();
  let outboundBytes = 0;
  let outboundSequence = 0;
  let drainTimer: unknown;
  let reconnectTimer: unknown;
  let terminalDisconnect: "PROTOCOL" | "POLICY" | null = null;

  const bodyDigest = (body: RunnerEnvelope["body"]): string =>
    createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");

  const durableEventId = (body: RunnerEnvelope["body"]): string | null =>
    body.kind === "HEARTBEAT" || body.kind === "HEADLESS_OUTPUT_CHUNK" ? null : body.eventId;

  for (const event of outboundStore.load()) {
    const parsed = RunnerMessageBodySchema.safeParse(event.body);
    if (
      !parsed.success ||
      durableEventId(parsed.data) !== event.eventId ||
      bodyDigest(parsed.data) !== event.digest
    ) {
      throw new Error("RUNNER_OUTBOUND_STORE_CORRUPT");
    }
    const bytes = Buffer.byteLength(JSON.stringify(parsed.data), "utf8") + 256;
    outbound.push({ body: parsed.data, bytes, durable: true, digest: event.digest });
    outboundBytes += bytes;
  }
  if (outbound.length > maximumOutboundItems || outboundBytes > maximumOutboundBytes) {
    throw new Error("RUNNER_OUTBOUND_STORE_LIMIT_EXCEEDED");
  }

  const fail = (code: number, reason: string): void => {
    failed = true;
    if (code === 1002) terminalDisconnect = "PROTOCOL";
    else if (code === 1008 || code === 4003) terminalDisconnect = "POLICY";
    socket?.close(code, reason);
  };

  const cancelReconnect = (): void => {
    if (reconnectTimer !== undefined) clearReconnect(reconnectTimer);
    reconnectTimer = undefined;
  };

  const requestReconnect = (): void => {
    if (reconnect.state !== "BACKING_OFF" || reconnectTimer !== undefined) return;
    const delay = reconnect.nextDelaySeconds();
    if (delay === null) return;
    reconnectTimer = scheduleReconnect(() => {
      reconnectTimer = undefined;
      void client.start().catch(() => undefined);
    }, delay * 1_000);
  };

  const cancelDrain = (): void => {
    if (drainTimer !== undefined) clearDrain(drainTimer);
    drainTimer = undefined;
  };

  const requeueDurable = (): void => {
    const replay = [...inFlight.values()].filter((entry) => entry.durable);
    inFlight.clear();
    outbound.unshift(...replay);
  };

  const retainedEvent = (eventId: string): Outbound | undefined =>
    inFlight.get(eventId) ?? outbound.find((entry) => durableEventId(entry.body) === eventId);

  const eventForRequest = (requestId: string): string | undefined => {
    const entry = [...inFlight.values(), ...outbound].find(
      (candidate) => "requestId" in candidate.body && candidate.body.requestId === requestId,
    );
    return entry ? (durableEventId(entry.body) ?? undefined) : undefined;
  };

  const completeEvent = (eventId: string): void => {
    const retained = retainedEvent(eventId);
    if (!retained) return;
    inFlight.delete(eventId);
    const ready = outbound.findIndex((entry) => durableEventId(entry.body) === eventId);
    if (ready >= 0) outbound.splice(ready, 1);
    outboundBytes -= retained.bytes;
    processedResponses.delete(eventId);
    pendingAcknowledgements.delete(eventId);
    outboundStore.remove(eventId);
  };

  const acceptEnvelope = (candidate: unknown, wire: string): void => {
    if (failed) return;
    const envelope = ServerEnvelopeSchema.safeParse(candidate);
    if (!envelope.success || envelope.data.protocolVersion !== selectedVersion) {
      fail(1002, "PROTOCOL_ERROR");
      return;
    }
    const currentTime = now();
    if (
      envelope.data.issuedAt > currentTime + MAXIMUM_FUTURE_SKEW_SECONDS ||
      envelope.data.expiresAt <= currentTime ||
      envelope.data.expiresAt <= envelope.data.issuedAt ||
      envelope.data.expiresAt - envelope.data.issuedAt > MAXIMUM_SERVER_ENVELOPE_LIFETIME_SECONDS
    ) {
      fail(1002, "PROTOCOL_ERROR");
      return;
    }
    const wireDigest = createHash("sha256").update(wire, "utf8").digest("hex");
    const prior = seen.get(envelope.data.messageId);
    if (prior) {
      if (prior.sequence !== envelope.data.sequence || prior.digest !== wireDigest) {
        fail(1002, "PROTOCOL_ERROR");
      }
      return;
    }
    if (envelope.data.sequence <= lastSequence) {
      fail(1002, "PROTOCOL_ERROR");
      return;
    }
    lastSequence = envelope.data.sequence;
    seen.set(envelope.data.messageId, { sequence: envelope.data.sequence, digest: wireDigest });
    if (seen.size > MAXIMUM_REPLAY_ENTRIES) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    effects = effects
      .then(async () => {
        await dependencies.onEnvelope(envelope.data);
        if (envelope.data.body.kind === "AUTHORITY_RESPONSE") {
          const eventId = eventForRequest(envelope.data.body.requestId);
          if (eventId) {
            processedResponses.add(eventId);
            if (pendingAcknowledgements.has(eventId)) completeEvent(eventId);
          }
        }
        if (envelope.data.body.kind === "SEMANTIC_EVENT_ACK") {
          const eventId = envelope.data.body.eventId;
          const retained = retainedEvent(eventId);
          if (!retained) return;
          if ("requestId" in retained.body && !processedResponses.has(eventId)) {
            pendingAcknowledgements.add(eventId);
            return;
          }
          completeEvent(eventId);
        }
      })
      .catch(() => fail(1011, "INTERNAL_ERROR"));
  };

  const requestDrain = (): void => {
    if (drainTimer !== undefined || outbound.length === 0 || reconnect.state !== "ACTIVE") return;
    drainTimer = scheduleDrain(() => {
      drainTimer = undefined;
      flushOutbound();
    }, 25);
  };

  const flushOutbound = (): number => {
    if (reconnect.state !== "ACTIVE" || !socket || !selectedVersion) return 0;
    cancelDrain();
    let sent = 0;
    while (outbound.length > 0 && (socket.bufferedAmount ?? 0) < 1024 * 1024) {
      const entry = outbound[0];
      if (!entry) break;
      const issuedAt = now();
      const envelope: RunnerEnvelope = {
        protocolVersion: selectedVersion,
        messageId: messageId(),
        sequence: ++outboundSequence,
        issuedAt,
        expiresAt: issuedAt + 30,
        body: entry.body,
      };
      if (!RunnerEnvelopeSchema.safeParse(envelope).success) {
        fail(1002, "PROTOCOL_ERROR");
        break;
      }
      try {
        socket.send(JSON.stringify(envelope));
      } catch {
        outboundSequence -= 1;
        break;
      }
      outbound.shift();
      const eventId = durableEventId(entry.body);
      if (eventId) inFlight.set(eventId, entry);
      else outboundBytes -= entry.bytes;
      sent += 1;
    }
    requestDrain();
    return sent;
  };

  const client = {
    get state() {
      return reconnect.state;
    },

    async start(): Promise<void> {
      cancelReconnect();
      const endpoint = validateEndpoint(dependencies.endpoint);
      if (reconnect.state === "BACKING_OFF") reconnect.retrying();
      else reconnect.authenticating();
      let issue: AccessIssue;
      try {
        issue = await dependencies.issueAccess();
      } catch (error) {
        reconnect.disconnected("AUTHENTICATION", now());
        throw error;
      }
      if (!boundedAccess(issue)) {
        reconnect.disconnected("AUTHENTICATION", now());
        throw new Error("RUNNER_ACCESS_ISSUE_INVALID");
      }
      let connection: RunnerClientSocket;
      try {
        connection = socketFactory(endpoint, {
          headers: {
            authorization: `DPoP ${issue.accessToken}`,
            dpop: issue.proof,
            "dpop-nonce": issue.nonce,
          },
        });
      } catch (error) {
        reconnect.disconnected("UNAVAILABLE", now());
        requestReconnect();
        throw error;
      }
      socket = connection;
      failed = false;
      terminalDisconnect = null;
      selectedVersion = null;
      lastSequence = 0;
      outboundSequence = 0;
      effects = Promise.resolve();
      seen.clear();
      connection.addEventListener("open", () => {
        if (socket !== connection) return;
        reconnect.negotiating();
        connection.send(JSON.stringify(hello));
      });
      connection.addEventListener("message", (event) => {
        if (socket !== connection) return;
        const data = (event as MessageEvent<unknown>).data;
        if (typeof data !== "string" || Buffer.byteLength(data, "utf8") > 65_536) {
          fail(1002, "PROTOCOL_ERROR");
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(data);
        } catch {
          fail(1002, "PROTOCOL_ERROR");
          return;
        }
        if (reconnect.state === "NEGOTIATING") {
          const welcome = ServerWelcomeSchema.safeParse(raw);
          if (
            !welcome.success ||
            !dependencies.supportedRanges.some((range) => {
              const parts = welcome.success
                ? welcome.data.selectedVersion.split(".").map(Number)
                : [0, 0];
              const major = parts[0] ?? 0;
              const minor = parts[1] ?? 0;
              return (
                range.major === major && minor >= range.minimumMinor && minor <= range.maximumMinor
              );
            })
          ) {
            fail(1002, "PROTOCOL_ERROR");
            return;
          }
          selectedVersion = welcome.data.selectedVersion;
          reconnect.active(now());
          flushOutbound();
          return;
        }
        if (reconnect.state !== "ACTIVE") {
          fail(1002, "PROTOCOL_ERROR");
          return;
        }
        acceptEnvelope(raw, data);
      });
      connection.addEventListener("close", () => {
        if (socket !== connection) return;
        if (reconnect.state !== "STOPPED") {
          cancelDrain();
          outbound.splice(0, outbound.length, ...outbound.filter((entry) => entry.durable));
          requeueDurable();
          outboundBytes = [...outbound, ...inFlight.values()].reduce(
            (total, entry) => total + entry.bytes,
            0,
          );
          reconnect.disconnected(terminalDisconnect ?? "NETWORK", now());
          terminalDisconnect = null;
          requestReconnect();
        }
      });
    },

    stop(): void {
      cancelReconnect();
      cancelDrain();
      reconnect.stop();
      fail(1000, "CLIENT_STOP");
      socket = null;
      outbound.length = 0;
      inFlight.clear();
      processedResponses.clear();
      pendingAcknowledgements.clear();
      outboundBytes = 0;
    },

    send(body: RunnerEnvelope["body"]): Result<Readonly<{ queued: boolean }>> {
      if (reconnect.state !== "ACTIVE" || !socket || !selectedVersion) {
        return outboundFailure("RUNNER_CONNECTION_INACTIVE", "Runner connection is inactive.");
      }
      const parsed = RunnerMessageBodySchema.safeParse(body);
      if (!parsed.success) {
        return outboundFailure("RUNNER_OUTBOUND_INVALID", "Runner outbound message is invalid.");
      }
      const bytes = Buffer.byteLength(JSON.stringify(parsed.data), "utf8") + 256;
      const eventId = durableEventId(parsed.data);
      const digest = bodyDigest(parsed.data);
      if (eventId) {
        const prior =
          inFlight.get(eventId) ?? outbound.find((entry) => durableEventId(entry.body) === eventId);
        if (prior) {
          if (prior.digest !== digest) {
            return outboundFailure(
              "RUNNER_EVENT_ID_CONFLICT",
              "Runner event identifier conflicts with retained content.",
            );
          }
          return { ok: true, value: { queued: true } };
        }
      }
      if (
        outbound.length >= maximumOutboundItems ||
        bytes > maximumOutboundBytes ||
        outboundBytes + bytes > maximumOutboundBytes
      ) {
        return outboundFailure(
          "RUNNER_OUTBOUND_BACKPRESSURE",
          "Runner outbound backpressure limit was reached.",
        );
      }
      const entry: Outbound = {
        body: parsed.data,
        bytes,
        durable: eventId !== null,
        ...(eventId ? { digest } : {}),
      };
      if (eventId) {
        try {
          outboundStore.put({ eventId, digest, body: parsed.data as DurableBody });
        } catch (error) {
          const code =
            error instanceof Error && error.message === "RUNNER_EVENT_ID_CONFLICT"
              ? "RUNNER_EVENT_ID_CONFLICT"
              : "RUNNER_OUTBOUND_BACKPRESSURE";
          return outboundFailure(
            code,
            code === "RUNNER_EVENT_ID_CONFLICT"
              ? "Runner event identifier conflicts with retained content."
              : "Runner durable outbound store is unavailable or full.",
          );
        }
      }
      outbound.push(entry);
      outboundBytes += bytes;
      flushOutbound();
      return { ok: true, value: { queued: outbound.length > 0 } };
    },

    flushOutbound,

    async quiesce(deadline: number): Promise<Readonly<{ closed: number; pending: number }>> {
      if (!Number.isFinite(deadline) || deadline < 0)
        throw new Error("RUNNER_QUIESCE_DEADLINE_INVALID");
      while (outbound.length > 0 && reconnect.state === "ACTIVE" && now() < deadline) {
        flushOutbound();
        if (outbound.length === 0 || now() >= deadline) break;
        await waitForDrain(deadline);
      }
      const pending = new Set(
        [...outbound, ...inFlight.values()]
          .map((entry) => durableEventId(entry.body))
          .filter((value): value is string => value !== null),
      ).size;
      const closed = socket === null ? 0 : 1;
      this.stop();
      return { closed, pending };
    },
  };
  return client;
}
