import { describe, expect, test } from "bun:test";
import { BoundedSendQueue, TokenBucket } from "../../src/server/adapters/wss/rate-limits.ts";
import { createInMemoryRunnerChannel, validRunnerHeartbeat } from "../fixtures/runner-channel.ts";

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

  test("charges every authenticated frame against the advertised runner bucket", () => {
    const channel = createInMemoryRunnerChannel({ active: true, now: () => 1_000 });
    for (let sequence = 1; sequence <= 200; sequence += 1) {
      expect(
        channel.receiveText(
          JSON.stringify(validRunnerHeartbeat({ messageId: `message_${sequence}`, sequence })),
        ),
      ).toEqual({ accepted: true });
    }
    expect(
      channel.receiveText(
        JSON.stringify(validRunnerHeartbeat({ messageId: "message_201", sequence: 201 })),
      ),
    ).toEqual({ accepted: false, code: "RUNNER_RATE_LIMITED", close: true });
  });

  test("enforces the per-run bucket independently from the runner bucket", () => {
    const channel = createInMemoryRunnerChannel({ active: true, now: () => 1_000 });
    for (let sequence = 1; sequence <= 100; sequence += 1) {
      expect(
        channel.receiveText(
          JSON.stringify({
            ...validRunnerHeartbeat({ messageId: `run_message_${sequence}`, sequence }),
            body: {
              kind: "ATTEMPT_EVENT",
              eventId: `event_${sequence}`,
              payload: {
                runId: "run_1",
                expectedRunRevision: 1,
                attemptId: "attempt_1",
                expectedAttemptRevision: sequence,
                event: { kind: "PROCESS_STARTED", observedAt: 1_000 },
              },
            },
          }),
        ),
      ).toEqual({ accepted: true });
    }
    expect(
      channel.receiveText(
        JSON.stringify({
          ...validRunnerHeartbeat({ messageId: "run_message_101", sequence: 101 }),
          body: {
            kind: "ATTEMPT_EVENT",
            eventId: "event_101",
            payload: {
              runId: "run_1",
              expectedRunRevision: 1,
              attemptId: "attempt_1",
              expectedAttemptRevision: 101,
              event: { kind: "PROCESS_STARTED", observedAt: 1_000 },
            },
          },
        }),
      ),
    ).toEqual({ accepted: false, code: "RUN_RATE_LIMITED", close: true });
  });

  test("bounds replay and per-run rate metadata for long-lived connections", () => {
    let now = 1_000;
    const channel = createInMemoryRunnerChannel({
      active: true,
      now: () => now,
      maximumReplayEntries: 3,
      maximumRunBuckets: 2,
    });
    for (let sequence = 1; sequence <= 8; sequence += 1) {
      now += 1;
      expect(
        channel.receiveText(
          JSON.stringify({
            ...validRunnerHeartbeat({
              messageId: `bounded_message_${sequence}`,
              sequence,
              issuedAt: now,
              expiresAt: now + 10,
            }),
            body: {
              kind: "ATTEMPT_EVENT",
              eventId: `event_${sequence}`,
              payload: {
                runId: `run_${sequence}`,
                expectedRunRevision: 1,
                attemptId: `attempt_${sequence}`,
                expectedAttemptRevision: 1,
                event: { kind: "PROCESS_STARTED", observedAt: now },
              },
            },
          }),
        ),
      ).toEqual({ accepted: true });
    }
    expect(channel.inspectRetainedState()).toEqual({ replayEntries: 3, runBuckets: 2 });
  });
});
