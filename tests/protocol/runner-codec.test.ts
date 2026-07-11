import { describe, expect, test } from "bun:test";
import { createInMemoryRunnerChannel, validRunnerHeartbeat } from "../fixtures/runner-channel.ts";

describe("runner wire codec", () => {
  test("rejects unknown kinds, binary, compression, invalid UTF-8, and oversized frames", () => {
    const channel = createInMemoryRunnerChannel({ active: true });
    expect(channel.receiveText('{"kind":"SHELL","command":"id"}')).toEqual({
      accepted: false,
      code: "FRAME_KIND_DENIED",
      close: true,
    });
    expect(channel.receiveBinary(new Uint8Array([1, 2, 3]))).toEqual({
      accepted: false,
      code: "BINARY_FRAME_DENIED",
      close: true,
    });
    expect(channel.receiveCompressed(new TextEncoder().encode("{}"))).toEqual({
      accepted: false,
      code: "COMPRESSED_FRAME_DENIED",
      close: true,
    });
    expect(channel.receiveBytes(new Uint8Array([0xc3, 0x28]))).toEqual({
      accepted: false,
      code: "FRAME_UTF8_INVALID",
      close: true,
    });
    expect(channel.receiveText(" ".repeat(65_537))).toEqual({
      accepted: false,
      code: "FRAME_TOO_LARGE",
      close: true,
    });
  });

  test("deduplicates identical envelopes and rejects changed replays and sequence regression", () => {
    const channel = createInMemoryRunnerChannel({ active: true });
    const frame = validRunnerHeartbeat({ messageId: "message_1", sequence: 1 });
    expect(channel.receiveText(JSON.stringify(frame))).toEqual({ accepted: true });
    expect(channel.receiveText(JSON.stringify(frame))).toEqual({ accepted: true, duplicate: true });
    expect(
      channel.receiveText(JSON.stringify({ ...frame, body: { ...frame.body, observedEpoch: 2 } })),
    ).toEqual({ accepted: false, code: "FRAME_ID_CONFLICT", close: true });
    expect(
      channel.receiveText(
        JSON.stringify(validRunnerHeartbeat({ messageId: "message_2", sequence: 1 })),
      ),
    ).toEqual({ accepted: false, code: "FRAME_SEQUENCE_REGRESSION", close: true });
  });

  test("measures UTF-8 bytes and enforces issue/expiry bounds", () => {
    const channel = createInMemoryRunnerChannel({ active: true, now: () => 1_000 });
    const frame = validRunnerHeartbeat({ messageId: "message_1", sequence: 1 });
    const padded = JSON.stringify({
      ...frame,
      body: { ...frame.body, padding: "é".repeat(33_000) },
    });
    expect(padded.length).toBeLessThan(65_536);
    expect(channel.receiveText(padded)).toEqual({
      accepted: false,
      code: "FRAME_TOO_LARGE",
      close: true,
    });
    expect(channel.receiveText(JSON.stringify({ ...frame, issuedAt: 1_301 }))).toEqual({
      accepted: false,
      code: "FRAME_TIME_INVALID",
      close: true,
    });
    expect(channel.receiveText(JSON.stringify({ ...frame, expiresAt: 1_000 }))).toEqual({
      accepted: false,
      code: "FRAME_TIME_INVALID",
      close: true,
    });
  });
});
