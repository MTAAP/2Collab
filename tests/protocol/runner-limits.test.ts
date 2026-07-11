import { describe, expect, test } from "bun:test";
import { BoundedSendQueue, TokenBucket } from "../../src/server/adapters/wss/rate-limits.ts";

describe("runner transport limits", () => {
  test("refills a bounded token bucket without accumulating beyond burst", () => {
    let now = 0;
    const bucket = new TokenBucket({ ratePerSecond: 100, burst: 200, now: () => now });
    for (let index = 0; index < 200; index += 1) expect(bucket.consume()).toBeTrue();
    expect(bucket.consume()).toBeFalse();
    now = 0.5;
    for (let index = 0; index < 50; index += 1) expect(bucket.consume()).toBeTrue();
    expect(bucket.consume()).toBeFalse();
    now = 100;
    for (let index = 0; index < 200; index += 1) expect(bucket.consume()).toBeTrue();
    expect(bucket.consume()).toBeFalse();
  });

  test("bounds queue items and bytes and prioritizes termination", () => {
    const queue = new BoundedSendQueue<string>({ maximumItems: 2, maximumBytes: 8 });
    expect(queue.enqueue("work", 4, "NORMAL")).toBeTrue();
    expect(queue.enqueue("more", 4, "NORMAL")).toBeTrue();
    expect(queue.enqueue("overflow", 1, "NORMAL")).toBeFalse();
    expect(queue.enqueue("stop", 4, "CRITICAL")).toBeTrue();
    expect(queue.dequeue()).toBe("stop");
    expect(queue.dequeue()).toBe("more");
    expect(queue.dequeue()).toBeUndefined();
  });
});
