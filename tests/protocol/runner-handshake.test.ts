import { describe, expect, test } from "bun:test";
import { createInMemoryRunnerChannel } from "../fixtures/runner-channel.ts";
import { validRunnerHeartbeat } from "../fixtures/runner-channel.ts";

describe("runner handshake", () => {
  test("requires one bounded hello before application traffic", () => {
    const channel = createInMemoryRunnerChannel();
    expect(channel.receiveText('{"kind":"HEARTBEAT"}')).toEqual({
      accepted: false,
      code: "CLIENT_HELLO_REQUIRED",
      close: true,
    });
  });

  test("negotiates the highest common version and fences duplicate hello", () => {
    const channel = createInMemoryRunnerChannel({ supportedVersions: ["1.0", "1.1", "2.0"] });
    const hello = JSON.stringify({
      kind: "CLIENT_HELLO",
      ranges: [
        { major: 1, minimumMinor: 0, maximumMinor: 5 },
        { major: 2, minimumMinor: 0, maximumMinor: 0 },
      ],
    });
    expect(channel.receiveText(hello)).toEqual({
      accepted: true,
      welcome: expect.objectContaining({
        kind: "SERVER_WELCOME",
        selectedVersion: "2.0",
        fence: 1,
        limits: {
          maximumFrameBytes: 65_536,
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
      }),
    });
    expect(channel.receiveText(hello)).toEqual({
      accepted: false,
      code: "CLIENT_HELLO_DUPLICATE",
      close: true,
    });
  });

  test("rejects malformed, duplicate, excessive, and incompatible ranges", () => {
    for (const ranges of [
      [],
      Array.from({ length: 9 }, (_, index) => ({
        major: index + 1,
        minimumMinor: 0,
        maximumMinor: 0,
      })),
      [
        { major: 1, minimumMinor: 0, maximumMinor: 1 },
        { major: 1, minimumMinor: 2, maximumMinor: 3 },
      ],
      [{ major: 1, minimumMinor: 2, maximumMinor: 1 }],
    ]) {
      const channel = createInMemoryRunnerChannel();
      expect(channel.receiveText(JSON.stringify({ kind: "CLIENT_HELLO", ranges }))).toEqual({
        accepted: false,
        code: "CLIENT_HELLO_INVALID",
        close: true,
      });
    }
    const incompatible = createInMemoryRunnerChannel({ supportedVersions: ["2.0"] });
    expect(
      incompatible.receiveText(
        JSON.stringify({
          kind: "CLIENT_HELLO",
          ranges: [{ major: 1, minimumMinor: 0, maximumMinor: 9 }],
        }),
      ),
    ).toEqual({ accepted: false, code: "PROTOCOL_VERSION_UNSUPPORTED", close: true });
  });

  test("enforces the hello and application-heartbeat deadlines at exact boundaries", () => {
    let now = 1_000;
    const hello = createInMemoryRunnerChannel({ now: () => now });
    now = 1_009;
    expect(hello.checkTimeout()).toBeNull();
    now = 1_010;
    expect(hello.checkTimeout()).toEqual({
      accepted: false,
      code: "CLIENT_HELLO_TIMEOUT",
      close: true,
    });

    now = 2_000;
    const active = createInMemoryRunnerChannel({ active: true, now: () => now });
    now = 2_029;
    expect(active.checkTimeout()).toBeNull();
    expect(
      active.receiveText(
        JSON.stringify(
          validRunnerHeartbeat({
            messageId: "heartbeat_1",
            sequence: 1,
            issuedAt: 2_029,
            expiresAt: 2_039,
          }),
        ),
      ),
    ).toEqual({ accepted: true });
    now = 2_058;
    expect(active.checkTimeout()).toBeNull();
    now = 2_059;
    expect(active.checkTimeout()).toEqual({
      accepted: false,
      code: "RUNNER_HEARTBEAT_TIMEOUT",
      close: true,
    });
  });
});
