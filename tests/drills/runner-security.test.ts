import { describe, expect, test } from "bun:test";
import { createInMemoryRunnerProtocolChannel } from "../../src/server/adapters/wss/protocol.ts";
import { validRunnerHeartbeat } from "../fixtures/runner-channel.ts";

describe("runner security drill", () => {
  test("arbitrary commands, binary frames, and oversized frames never reach semantic routing", () => {
    const channel = createInMemoryRunnerProtocolChannel({ active: true, now: () => 1_000 });
    expect(
      channel.receiveText(JSON.stringify({ kind: "SHELL", command: "forbidden" })),
    ).toMatchObject({ accepted: false, code: "FRAME_KIND_DENIED" });
    expect(channel.receiveBinary(new Uint8Array([1]))).toMatchObject({
      accepted: false,
      code: "BINARY_FRAME_DENIED",
    });
    expect(channel.receiveText("x".repeat(65_537))).toMatchObject({
      accepted: false,
      code: "FRAME_TOO_LARGE",
    });
  });

  test("changed message replay and stale sequence fail closed", () => {
    const channel = createInMemoryRunnerProtocolChannel({ active: true, now: () => 1_000 });
    const frame = validRunnerHeartbeat({ messageId: "message_001", sequence: 1 });
    expect(channel.receiveText(JSON.stringify(frame))).toMatchObject({ accepted: true });
    expect(channel.receiveText(JSON.stringify(frame))).toMatchObject({
      accepted: true,
      duplicate: true,
    });
    expect(channel.receiveText(JSON.stringify({ ...frame, expiresAt: 1_061 }))).toMatchObject({
      accepted: false,
      code: "FRAME_ID_CONFLICT",
    });
  });
});
