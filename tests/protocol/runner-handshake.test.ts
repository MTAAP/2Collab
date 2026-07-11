import { describe, expect, test } from "bun:test";
import { createInMemoryRunnerChannel } from "../fixtures/runner-channel.ts";

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
        limits: expect.objectContaining({ maximumFrameBytes: 65_536 }),
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
});
