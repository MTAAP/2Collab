import { createHash } from "node:crypto";
import {
  ClientHelloSchema,
  ServerEnvelopeSchema,
  ServerWelcomeSchema,
  type ClientHello,
  type ServerEnvelope,
} from "../../shared/contracts/protocol.ts";
import { RunnerReconnectState } from "./reconnect.ts";

export type RunnerClientSocket = EventTarget &
  Readonly<{
    send(value: string): void;
    close(code: number, reason: string): void;
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
}>;

const MAXIMUM_FUTURE_SKEW_SECONDS = 30;
const MAXIMUM_SERVER_ENVELOPE_LIFETIME_SECONDS = 5 * 60;
const MAXIMUM_REPLAY_ENTRIES = 32_768;

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
  const reconnect = new RunnerReconnectState();
  const socketFactory = dependencies.socketFactory ?? defaultSocketFactory;
  const now = dependencies.now ?? (() => Date.now() / 1_000);
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

  const fail = (code: number, reason: string): void => {
    failed = true;
    socket?.close(code, reason);
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
      .then(() => dependencies.onEnvelope(envelope.data))
      .catch(() => fail(1011, "INTERNAL_ERROR"));
  };

  return {
    get state() {
      return reconnect.state;
    },

    async start(): Promise<void> {
      const endpoint = validateEndpoint(dependencies.endpoint);
      reconnect.authenticating();
      const issue = await dependencies.issueAccess();
      if (!boundedAccess(issue)) throw new Error("RUNNER_ACCESS_ISSUE_INVALID");
      socket = socketFactory(endpoint, {
        headers: {
          authorization: `DPoP ${issue.accessToken}`,
          dpop: issue.proof,
          "dpop-nonce": issue.nonce,
        },
      });
      failed = false;
      selectedVersion = null;
      lastSequence = 0;
      effects = Promise.resolve();
      seen.clear();
      socket.addEventListener("open", () => {
        reconnect.negotiating();
        socket?.send(JSON.stringify(hello));
      });
      socket.addEventListener("message", (event) => {
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
          return;
        }
        if (reconnect.state !== "ACTIVE") {
          fail(1002, "PROTOCOL_ERROR");
          return;
        }
        acceptEnvelope(raw, data);
      });
      socket.addEventListener("close", () => {
        if (reconnect.state !== "STOPPED") {
          reconnect.disconnected("NETWORK", now());
        }
      });
    },

    stop(): void {
      reconnect.stop();
      fail(1000, "CLIENT_STOP");
      socket = null;
    },
  };
}
