export class TokenBucket {
  readonly #ratePerSecond: number;
  readonly #burst: number;
  readonly #now: () => number;
  #tokens: number;
  #lastRefill: number;

  constructor(input: Readonly<{ ratePerSecond: number; burst: number; now: () => number }>) {
    if (input.ratePerSecond <= 0 || input.burst <= 0) throw new Error("TOKEN_BUCKET_INVALID");
    this.#ratePerSecond = input.ratePerSecond;
    this.#burst = input.burst;
    this.#now = input.now;
    this.#tokens = input.burst;
    this.#lastRefill = input.now();
  }

  consume(tokens = 1): boolean {
    if (!Number.isFinite(tokens) || tokens <= 0) return false;
    const now = this.#now();
    const elapsed = Math.max(0, now - this.#lastRefill);
    this.#tokens = Math.min(this.#burst, this.#tokens + elapsed * this.#ratePerSecond);
    this.#lastRefill = Math.max(this.#lastRefill, now);
    if (this.#tokens < tokens) return false;
    this.#tokens -= tokens;
    return true;
  }
}

type Priority = "NORMAL" | "CRITICAL";

type QueueEntry<T> = Readonly<{ value: T; bytes: number; priority: Priority }>;

export class BoundedSendQueue<T> {
  readonly #maximumItems: number;
  readonly #maximumBytes: number;
  readonly #entries: QueueEntry<T>[] = [];
  #bytes = 0;

  constructor(input: Readonly<{ maximumItems: number; maximumBytes: number }>) {
    if (
      !Number.isSafeInteger(input.maximumItems) ||
      input.maximumItems < 1 ||
      input.maximumBytes < 1
    ) {
      throw new Error("SEND_QUEUE_LIMIT_INVALID");
    }
    this.#maximumItems = input.maximumItems;
    this.#maximumBytes = input.maximumBytes;
  }

  enqueue(value: T, bytes: number, priority: Priority): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#maximumBytes) return false;
    if (priority === "CRITICAL") {
      while (
        (this.#entries.length >= this.#maximumItems || this.#bytes + bytes > this.#maximumBytes) &&
        this.#entries.some((entry) => entry.priority === "NORMAL")
      ) {
        const index = this.#entries.findIndex((entry) => entry.priority === "NORMAL");
        const [removed] = this.#entries.splice(index, 1);
        if (!removed) break;
        this.#bytes -= removed.bytes;
      }
    }
    if (this.#entries.length >= this.#maximumItems || this.#bytes + bytes > this.#maximumBytes) {
      return false;
    }
    const entry = { value, bytes, priority };
    if (priority === "CRITICAL") this.#entries.unshift(entry);
    else this.#entries.push(entry);
    this.#bytes += bytes;
    return true;
  }

  dequeue(): T | undefined {
    const entry = this.#entries.shift();
    if (!entry) return undefined;
    this.#bytes -= entry.bytes;
    return entry.value;
  }

  peek(): T | undefined {
    return this.#entries[0]?.value;
  }

  clear(): void {
    this.#entries.length = 0;
    this.#bytes = 0;
  }

  get size(): number {
    return this.#entries.length;
  }

  get bytes(): number {
    return this.#bytes;
  }
}
