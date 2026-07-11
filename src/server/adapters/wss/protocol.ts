import { createHash, randomBytes } from "node:crypto";
import {
  ClientHelloSchema,
  RunnerEnvelopeSchema,
  RunnerMessageBodySchema,
  type ClientHello,
} from "../../../shared/contracts/protocol.ts";
import { TokenBucket } from "./rate-limits.ts";

export const MAXIMUM_RUNNER_FRAME_BYTES = 65_536;
export const MAXIMUM_FUTURE_SKEW_SECONDS = 30;
export const MAXIMUM_RUNNER_ENVELOPE_LIFETIME_SECONDS = 5 * 60;

export type ServerWelcome = Readonly<{
  kind: "SERVER_WELCOME";
  selectedVersion: string;
  connectionId: string;
  fence: number;
  limits: Readonly<{
    maximumFrameBytes: number;
    runnerFramesPerSecond: number;
    runnerBurst: number;
    runFramesPerSecond: number;
    runBurst: number;
    sendQueueItems: number;
    sendQueueBytes: number;
    heartbeatSeconds: number;
    offlineSeconds: number;
    operationAckSeconds: number;
    outputChunkBytes: number;
    reconnectBufferBytes: number;
    reconnectBackoffSeconds: number;
  }>;
}>;

export type RunnerReceiveResult =
  | Readonly<{ accepted: true; duplicate?: true; welcome?: ServerWelcome }>
  | Readonly<{ accepted: false; code: string; close: true }>;

type ChannelOptions = Readonly<{
  active?: boolean;
  supportedVersions?: readonly string[];
  now?: () => number;
  connectionId?: () => string;
  fence?: number;
}>;

function reject(code: string): RunnerReceiveResult {
  return { accepted: false, code, close: true };
}

function parseVersion(value: string): readonly [number, number] | null {
  const match = /^([1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

function compareVersion(left: readonly [number, number], right: readonly [number, number]): number {
  return left[0] - right[0] || left[1] - right[1];
}

function selectVersion(supported: readonly string[], ranges: ClientHello["ranges"]): string | null {
  const candidates = supported
    .map((value) => ({ value, version: parseVersion(value) }))
    .filter(
      (candidate): candidate is Readonly<{ value: string; version: readonly [number, number] }> =>
        candidate.version !== null,
    )
    .filter(({ version }) =>
      ranges.some(
        (range) =>
          range.major === version[0] &&
          version[1] >= range.minimumMinor &&
          version[1] <= range.maximumMinor,
      ),
    )
    .sort((left, right) => compareVersion(right.version, left.version));
  return candidates[0]?.value ?? null;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultConnectionId(): string {
  return `connection_${randomBytes(24).toString("base64url")}`;
}

export class InMemoryRunnerProtocolChannel {
  readonly #supportedVersions: readonly string[];
  readonly #now: () => number;
  readonly #connectionId: () => string;
  readonly #fence: number;
  readonly #seen = new Map<string, Readonly<{ sequence: number; digest: string }>>();
  readonly #runnerBucket: TokenBucket;
  readonly #runBuckets = new Map<string, TokenBucket>();
  readonly #openedAt: number;
  #active: boolean;
  #selectedVersion: string | null;
  #lastSequence = 0;
  #lastHeartbeatAt: number;

  constructor(options: ChannelOptions = {}) {
    this.#supportedVersions = options.supportedVersions ?? ["1.0"];
    this.#now = options.now ?? (() => 1_000);
    this.#connectionId = options.connectionId ?? defaultConnectionId;
    this.#fence = options.fence ?? 1;
    this.#runnerBucket = new TokenBucket({ ratePerSecond: 100, burst: 200, now: this.#now });
    this.#openedAt = this.#now();
    this.#lastHeartbeatAt = this.#openedAt;
    this.#active = options.active ?? false;
    this.#selectedVersion = this.#active ? (this.#supportedVersions[0] ?? null) : null;
  }

  receiveBinary(_bytes: Uint8Array): RunnerReceiveResult {
    return reject("BINARY_FRAME_DENIED");
  }

  receiveCompressed(_bytes: Uint8Array): RunnerReceiveResult {
    return reject("COMPRESSED_FRAME_DENIED");
  }

  receiveBytes(bytes: Uint8Array): RunnerReceiveResult {
    if (bytes.byteLength > MAXIMUM_RUNNER_FRAME_BYTES) return reject("FRAME_TOO_LARGE");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return reject("FRAME_UTF8_INVALID");
    }
    return this.#receiveDecoded(text, bytes);
  }

  receiveText(text: string): RunnerReceiveResult {
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > MAXIMUM_RUNNER_FRAME_BYTES) return reject("FRAME_TOO_LARGE");
    return this.#receiveDecoded(text, bytes);
  }

  checkTimeout(): RunnerReceiveResult | null {
    const now = this.#now();
    if (!this.#active && now - this.#openedAt >= 10) return reject("CLIENT_HELLO_TIMEOUT");
    if (this.#active && now - this.#lastHeartbeatAt >= 30) {
      return reject("RUNNER_HEARTBEAT_TIMEOUT");
    }
    return null;
  }

  #receiveDecoded(text: string, bytes: Uint8Array): RunnerReceiveResult {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return reject("FRAME_JSON_INVALID");
    }
    if (!this.#active) return this.#receiveHello(raw);
    if (!this.#runnerBucket.consume()) return reject("RUNNER_RATE_LIMITED");
    if (
      typeof raw === "object" &&
      raw !== null &&
      (raw as { kind?: unknown }).kind === "CLIENT_HELLO"
    ) {
      return reject("CLIENT_HELLO_DUPLICATE");
    }
    return this.#receiveEnvelope(raw, bytes);
  }

  #receiveHello(raw: unknown): RunnerReceiveResult {
    if (
      typeof raw !== "object" ||
      raw === null ||
      (raw as { kind?: unknown }).kind !== "CLIENT_HELLO"
    ) {
      return reject("CLIENT_HELLO_REQUIRED");
    }
    const parsed = ClientHelloSchema.safeParse(raw);
    if (!parsed.success) return reject("CLIENT_HELLO_INVALID");
    const selectedVersion = selectVersion(this.#supportedVersions, parsed.data.ranges);
    if (!selectedVersion) return reject("PROTOCOL_VERSION_UNSUPPORTED");
    this.#active = true;
    this.#selectedVersion = selectedVersion;
    this.#lastHeartbeatAt = this.#now();
    return {
      accepted: true,
      welcome: {
        kind: "SERVER_WELCOME",
        selectedVersion,
        connectionId: this.#connectionId(),
        fence: this.#fence,
        limits: {
          maximumFrameBytes: MAXIMUM_RUNNER_FRAME_BYTES,
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
        },
      },
    };
  }

  #receiveEnvelope(raw: unknown, bytes: Uint8Array): RunnerReceiveResult {
    if (typeof raw !== "object" || raw === null) return reject("FRAME_INVALID");
    const candidate = raw as { messageId?: unknown; sequence?: unknown; body?: { kind?: unknown } };
    if (
      typeof candidate.body?.kind !== "string" ||
      !RunnerMessageBodySchema.options.some(
        (schema) => schema.shape.kind.value === candidate.body?.kind,
      )
    ) {
      return reject("FRAME_KIND_DENIED");
    }
    const frameDigest = digest(bytes);
    if (typeof candidate.messageId === "string") {
      const prior = this.#seen.get(candidate.messageId);
      if (prior) {
        return prior.digest === frameDigest && prior.sequence === candidate.sequence
          ? { accepted: true, duplicate: true }
          : reject("FRAME_ID_CONFLICT");
      }
    }
    if (typeof candidate.sequence === "number" && candidate.sequence <= this.#lastSequence) {
      return reject("FRAME_SEQUENCE_REGRESSION");
    }
    const parsed = RunnerEnvelopeSchema.safeParse(raw);
    if (!parsed.success || parsed.data.protocolVersion !== this.#selectedVersion) {
      return reject("FRAME_INVALID");
    }
    const runScope = this.#runScope(parsed.data.body);
    if (runScope) {
      let bucket = this.#runBuckets.get(runScope);
      if (!bucket) {
        bucket = new TokenBucket({ ratePerSecond: 50, burst: 100, now: this.#now });
        this.#runBuckets.set(runScope, bucket);
      }
      if (!bucket.consume()) return reject("RUN_RATE_LIMITED");
    }
    const now = this.#now();
    if (
      parsed.data.issuedAt > now + MAXIMUM_FUTURE_SKEW_SECONDS ||
      parsed.data.expiresAt <= now ||
      parsed.data.expiresAt <= parsed.data.issuedAt ||
      parsed.data.expiresAt - parsed.data.issuedAt > MAXIMUM_RUNNER_ENVELOPE_LIFETIME_SECONDS
    ) {
      return reject("FRAME_TIME_INVALID");
    }
    this.#lastSequence = parsed.data.sequence;
    this.#seen.set(parsed.data.messageId, {
      sequence: parsed.data.sequence,
      digest: frameDigest,
    });
    if (parsed.data.body.kind === "HEARTBEAT") this.#lastHeartbeatAt = now;
    return { accepted: true };
  }

  #runScope(body: (typeof RunnerEnvelopeSchema)["_output"]["body"]): string | null {
    if ("attemptId" in body) return `ATTEMPT:${body.attemptId}`;
    if ("gateEvaluationId" in body) return `GATE:${body.gateEvaluationId}`;
    if (body.kind === "HEADLESS_OUTPUT_CHUNK") {
      return body.target.kind === "ATTEMPT"
        ? `ATTEMPT:${body.target.attemptId}`
        : `GATE:${body.target.gateEvaluationId}`;
    }
    return null;
  }
}

export function createInMemoryRunnerProtocolChannel(
  options: ChannelOptions = {},
): InMemoryRunnerProtocolChannel {
  return new InMemoryRunnerProtocolChannel(options);
}
