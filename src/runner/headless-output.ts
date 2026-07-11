import type { RunnerEnvelope } from "../shared/contracts/protocol.ts";
import type { Result } from "../shared/contracts/result.ts";
import type {
  ExecutionAdapter,
  NormalizedRuntimeEvent,
  RuntimeOutputEvent,
} from "./execution-contract.ts";
import { SplitSafeRedactor } from "./redaction.ts";

type OutputBody = Extract<RunnerEnvelope["body"], Readonly<{ kind: "HEADLESS_OUTPUT_CHUNK" }>>;
type Target = OutputBody["target"];
type Output = Extract<NormalizedRuntimeEvent, Readonly<{ kind: "OUTPUT" }>>;

export type HeadlessOutputTransport = Readonly<{
  send: (body: OutputBody) => Promise<void>;
  maximumPendingItems?: number;
  maximumPendingBytes?: number;
  redactionHoldbackBytes?: number;
}>;

type Dependencies = HeadlessOutputTransport &
  Readonly<{
    adapter: ExecutionAdapter;
    target: Target;
  }>;

type Queued = Readonly<{ output: Output; bytes: number }>;

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "REFRESH" } };
}

function utf8Chunks(value: string, maximumBytes: number): readonly string[] {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes && chunk.length > 0) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

export function createHeadlessOutputProducer(dependencies: Dependencies) {
  const maximumPendingItems = dependencies.maximumPendingItems ?? 1_024;
  const maximumPendingBytes = dependencies.maximumPendingBytes ?? 1024 * 1024;
  if (
    !Number.isSafeInteger(maximumPendingItems) ||
    maximumPendingItems < 1 ||
    !Number.isSafeInteger(maximumPendingBytes) ||
    maximumPendingBytes < 1
  ) {
    throw new Error("OUTPUT_QUEUE_LIMIT_INVALID");
  }
  const redactor = new SplitSafeRedactor({
    ...(dependencies.redactionHoldbackBytes === undefined
      ? {}
      : { holdbackBytes: dependencies.redactionHoldbackBytes }),
  });
  const queue: Queued[] = [];
  const streamSequences = new Map<Output["stream"], number>();
  let pendingItems = 0;
  let pendingBytes = 0;
  let draining: Promise<void> | null = null;
  let finished = false;

  const sendText = async (stream: Output["stream"], text: string): Promise<void> => {
    for (const chunk of utf8Chunks(text, 16 * 1024)) {
      const streamSequence = (streamSequences.get(stream) ?? 0) + 1;
      streamSequences.set(stream, streamSequence);
      const body: OutputBody = {
        kind: "HEADLESS_OUTPUT_CHUNK",
        target: dependencies.target,
        stream,
        sequence: streamSequence,
        redactionVersion: 1,
        text: chunk,
        truncated: false,
      };
      await dependencies.send(body);
    }
  };

  const drain = (): Promise<void> => {
    if (draining) return draining;
    draining = (async () => {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry) break;
        try {
          await sendText(
            entry.output.stream,
            redactor.push(entry.output.stream, entry.output.text),
          );
        } finally {
          pendingItems -= 1;
          pendingBytes -= entry.bytes;
        }
      }
    })().finally(() => {
      draining = null;
      if (queue.length > 0) void drain();
    });
    return draining;
  };

  return {
    push(event: RuntimeOutputEvent): Result<Readonly<{ queued: true }>> {
      if (finished) return failure("OUTPUT_FINISHED", "Headless output is finished.");
      const normalized = dependencies.adapter.normalize(event);
      if (!normalized.ok) return normalized;
      if (normalized.value.kind !== "OUTPUT") {
        return { ok: true, value: { queued: true } };
      }
      const bytes = Buffer.byteLength(normalized.value.text, "utf8");
      if (
        pendingItems >= maximumPendingItems ||
        bytes > maximumPendingBytes ||
        pendingBytes + bytes > maximumPendingBytes
      ) {
        return failure("OUTPUT_BACKPRESSURE", "Headless output backpressure limit was reached.");
      }
      pendingItems += 1;
      pendingBytes += bytes;
      queue.push({ output: normalized.value, bytes });
      void drain();
      return { ok: true, value: { queued: true } };
    },

    async finish(): Promise<void> {
      if (finished) return;
      finished = true;
      await drain();
      for (const stream of ["STDOUT", "STDERR"] as const) {
        await sendText(stream, redactor.flush(stream));
      }
    },
  };
}
