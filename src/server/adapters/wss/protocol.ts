import { createHash, randomBytes } from "node:crypto";
import {
  ClientHelloSchema,
  RunnerEnvelopeSchema,
  RunnerMessageBodySchema,
  type ClientHello,
} from "../../../shared/contracts/protocol.ts";

export const MAXIMUM_RUNNER_FRAME_BYTES = 65_536;
export const MAXIMUM_FUTURE_SKEW_SECONDS = 5 * 60;

export type ServerWelcome = Readonly<{
  kind: "SERVER_WELCOME";
  selectedVersion: string;
  connectionId: string;
  fence: number;
  limits: Readonly<{
    maximumFrameBytes: number;
    runnerFramesPerSecond: number;
    runnerBurst: number;
    heartbeatSeconds: number;
    offlineSeconds: number;
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
  #active: boolean;
  #selectedVersion: string | null;
  #lastSequence = 0;

  constructor(options: ChannelOptions = {}) {
    this.#supportedVersions = options.supportedVersions ?? ["1.0"];
    this.#now = options.now ?? (() => 1_000);
    this.#connectionId = options.connectionId ?? defaultConnectionId;
    this.#fence = options.fence ?? 1;
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

  #receiveDecoded(text: string, bytes: Uint8Array): RunnerReceiveResult {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return reject("FRAME_JSON_INVALID");
    }
    if (!this.#active) return this.#receiveHello(raw);
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
          heartbeatSeconds: 10,
          offlineSeconds: 30,
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
    const now = this.#now();
    if (
      parsed.data.issuedAt > now + MAXIMUM_FUTURE_SKEW_SECONDS ||
      parsed.data.expiresAt <= now ||
      parsed.data.expiresAt <= parsed.data.issuedAt
    ) {
      return reject("FRAME_TIME_INVALID");
    }
    this.#lastSequence = parsed.data.sequence;
    this.#seen.set(parsed.data.messageId, {
      sequence: parsed.data.sequence,
      digest: frameDigest,
    });
    return { accepted: true };
  }
}

export function createInMemoryRunnerProtocolChannel(
  options: ChannelOptions = {},
): InMemoryRunnerProtocolChannel {
  return new InMemoryRunnerProtocolChannel(options);
}
