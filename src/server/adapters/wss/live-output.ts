import { createHash } from "node:crypto";

type TargetKind = "ATTEMPT" | "GATE";
type Stream = "STDOUT" | "STDERR";
type Interaction = "HEADLESS" | "INTERACTIVE";
const RETAINED_CHUNK_METADATA_BYTES = 160;
const RETAINED_REPLAY_METADATA_BYTES = 96;

export type LiveOutputChunk = Readonly<{
  stream: Stream;
  sequence: number;
  text: string;
  redactionVersion: number;
  truncated: boolean;
  gap: boolean;
  evictedBefore: boolean;
}>;

type StoredChunk = LiveOutputChunk &
  Readonly<{ bytes: number; retainedBytes: number; digest: string; ordinal: number }>;
type Target = {
  interaction: Interaction;
  chunks: StoredChunk[];
  seen: Map<string, string>;
  lastSequences: Map<Stream, number>;
  bytes: number;
};

function targetKey(kind: TargetKind, id: string): string {
  return `${kind}:${id}`;
}

function redact(text: string): string {
  return text
    .replace(/gh[opurs]_[A-Za-z0-9]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{20,}/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_KEY]");
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class LiveOutputHub {
  readonly #maximumProcessBytes: number;
  readonly #maximumTargetBytes: number;
  readonly #targets = new Map<string, Target>();
  #bytes = 0;
  #ordinal = 0;

  constructor(input: Readonly<{ maximumProcessBytes?: number; maximumTargetBytes?: number }> = {}) {
    this.#maximumProcessBytes = input.maximumProcessBytes ?? 64 * 1024 * 1024;
    this.#maximumTargetBytes = input.maximumTargetBytes ?? 1024 * 1024;
    if (this.#maximumProcessBytes < 1 || this.#maximumTargetBytes < 1) {
      throw new Error("OUTPUT_LIMIT_INVALID");
    }
  }

  activate(kind: TargetKind, id: string, interaction: Interaction): void {
    this.#targets.set(targetKey(kind, id), {
      interaction,
      chunks: [],
      seen: new Map(),
      lastSequences: new Map(),
      bytes: 0,
    });
  }

  accept(
    kind: TargetKind,
    id: string,
    stream: Stream,
    sequence: number,
    sourceText: string,
    redactionVersion: number,
    truncated: boolean,
  ):
    | Readonly<{
        accepted: true;
        duplicate?: true;
        gap: boolean;
        truncated: boolean;
      }>
    | Readonly<{ accepted: false; code: string }> {
    const target = this.#targets.get(targetKey(kind, id));
    if (!target) return { accepted: false, code: "OUTPUT_TARGET_INACTIVE" };
    if (target.interaction !== "HEADLESS") {
      return { accepted: false, code: "OUTPUT_INTERACTIVE_DENIED" };
    }
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      !Number.isSafeInteger(redactionVersion) ||
      redactionVersion < 1
    ) {
      return { accepted: false, code: "OUTPUT_INPUT_INVALID" };
    }
    if (Buffer.byteLength(sourceText, "utf8") > 16 * 1024) {
      return { accepted: false, code: "OUTPUT_CHUNK_TOO_LARGE" };
    }
    const safeText = redact(sourceText);
    const chunkDigest = digest(
      JSON.stringify({ stream, sequence, safeText, redactionVersion, truncated }),
    );
    const replayKey = `${stream}:${sequence}`;
    const prior = target.seen.get(replayKey);
    if (prior) {
      return prior === chunkDigest
        ? { accepted: true, duplicate: true, gap: false, truncated }
        : { accepted: false, code: "OUTPUT_SEQUENCE_CONFLICT" };
    }
    const previousSequence = target.lastSequences.get(stream);
    if (previousSequence !== undefined && sequence <= previousSequence) {
      return { accepted: false, code: "OUTPUT_SEQUENCE_REGRESSION" };
    }
    const gap = previousSequence !== undefined && sequence > previousSequence + 1;
    const bytes = Buffer.byteLength(safeText, "utf8");
    const retainedBytes = bytes + RETAINED_CHUNK_METADATA_BYTES + RETAINED_REPLAY_METADATA_BYTES;
    const chunk: StoredChunk = {
      stream,
      sequence,
      text: safeText,
      redactionVersion,
      truncated,
      gap,
      evictedBefore: false,
      bytes,
      retainedBytes,
      digest: chunkDigest,
      ordinal: ++this.#ordinal,
    };
    target.chunks.push(chunk);
    target.seen.set(replayKey, chunkDigest);
    target.lastSequences.set(stream, sequence);
    target.bytes += retainedBytes;
    this.#bytes += retainedBytes;
    this.#evict();
    return { accepted: true, gap, truncated };
  }

  #evict(): void {
    for (const target of this.#targets.values()) {
      while (target.bytes > this.#maximumTargetBytes && target.chunks.length > 0) {
        this.#evictChunk(target, 0);
      }
    }
    while (this.#bytes > this.#maximumProcessBytes) {
      let oldestTarget: Target | undefined;
      let oldestOrdinal = Number.POSITIVE_INFINITY;
      for (const target of this.#targets.values()) {
        const ordinal = target.chunks[0]?.ordinal;
        if (ordinal !== undefined && ordinal < oldestOrdinal) {
          oldestOrdinal = ordinal;
          oldestTarget = target;
        }
      }
      if (!oldestTarget) break;
      this.#evictChunk(oldestTarget, 0);
    }
  }

  #evictChunk(target: Target, index: number): void {
    const [removed] = target.chunks.splice(index, 1);
    if (!removed) return;
    target.bytes -= removed.retainedBytes;
    this.#bytes -= removed.retainedBytes;
    target.seen.delete(`${removed.stream}:${removed.sequence}`);
    const first = target.chunks[0];
    if (first) target.chunks[0] = { ...first, evictedBefore: true };
  }

  inspect(kind: TargetKind, id: string): readonly LiveOutputChunk[] {
    return (this.#targets.get(targetKey(kind, id))?.chunks ?? []).map(
      ({
        bytes: _bytes,
        retainedBytes: _retainedBytes,
        digest: _digest,
        ordinal: _ordinal,
        ...chunk
      }) => chunk,
    );
  }

  clear(kind: TargetKind, id: string): void {
    const key = targetKey(kind, id);
    const target = this.#targets.get(key);
    if (!target) return;
    this.#bytes -= target.bytes;
    this.#targets.delete(key);
  }

  clearAll(): void {
    this.#targets.clear();
    this.#bytes = 0;
  }
}
