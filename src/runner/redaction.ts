type Stream = "STDOUT" | "STDERR";

type StreamState = {
  pending: string;
  privateKey: boolean;
};

function redactKnownSecrets(value: string): string {
  return value
    .replace(/gh[opurs]_[A-Za-z0-9]{20,512}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{20,512}/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_KEY]")
    .replace(/(Authorization:\s*(?:Bearer|Basic)\s+)[^\s]{8,512}/gi, "$1[REDACTED]")
    .replace(/((?:password|token|secret)\s*[=:]\s*)[^\s]{8,512}/gi, "$1[REDACTED]");
}

function splitWithByteHoldback(value: string, holdbackBytes: number): readonly [string, string] {
  const total = Buffer.byteLength(value, "utf8");
  if (total <= holdbackBytes) return ["", value];
  const target = total - holdbackBytes;
  let emittedBytes = 0;
  let emittedCharacters = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (emittedBytes + bytes > target) break;
    emittedBytes += bytes;
    emittedCharacters += character.length;
  }
  return [value.slice(0, emittedCharacters), value.slice(emittedCharacters)];
}

export class SplitSafeRedactor {
  readonly #holdbackBytes: number;
  readonly #streams = new Map<Stream, StreamState>();

  constructor(input: Readonly<{ holdbackBytes?: number }> = {}) {
    this.#holdbackBytes = input.holdbackBytes ?? 512;
    if (
      !Number.isSafeInteger(this.#holdbackBytes) ||
      this.#holdbackBytes < 128 ||
      this.#holdbackBytes > 8_192
    ) {
      throw new Error("REDACTION_HOLDBACK_INVALID");
    }
  }

  #state(stream: Stream): StreamState {
    const state = this.#streams.get(stream) ?? { pending: "", privateKey: false };
    this.#streams.set(stream, state);
    return state;
  }

  #removePrivateKeys(state: StreamState, value: string): string {
    let remaining = value;
    let safe = "";
    while (remaining.length > 0) {
      if (state.privateKey) {
        const end = /-----END [^-\r\n]{1,80}PRIVATE KEY-----/.exec(remaining);
        if (!end) return safe;
        remaining = remaining.slice((end.index ?? 0) + end[0].length);
        state.privateKey = false;
        continue;
      }
      const begin = /-----BEGIN [^-\r\n]{1,80}PRIVATE KEY-----/.exec(remaining);
      if (!begin) return safe + remaining;
      safe += `${remaining.slice(0, begin.index)}[REDACTED_PRIVATE_KEY]`;
      remaining = remaining.slice((begin.index ?? 0) + begin[0].length);
      state.privateKey = true;
    }
    return safe;
  }

  push(stream: Stream, text: string): string {
    if (Buffer.byteLength(text, "utf8") > 16 * 1024) throw new Error("REDACTION_CHUNK_TOO_LARGE");
    const state = this.#state(stream);
    const sanitized = this.#removePrivateKeys(state, state.pending + text);
    const [emit, pending] = splitWithByteHoldback(sanitized, this.#holdbackBytes);
    state.pending = pending;
    return redactKnownSecrets(emit);
  }

  flush(stream: Stream): string {
    const state = this.#state(stream);
    const safe = state.privateKey ? "" : redactKnownSecrets(state.pending);
    state.pending = "";
    state.privateKey = false;
    return safe;
  }
}
