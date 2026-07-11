import { describe, expect, test } from "bun:test";
import { createRunnerWssClient } from "../../src/runner/transport/wss-client.ts";

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];
  readonly closes: Array<readonly [number, string]> = [];
  send(value: string): void {
    this.sent.push(value);
  }
  close(code: number, reason: string): void {
    this.closes.push([code, reason]);
  }
}

describe("runner WSS client", () => {
  test("uses Bun custom headers and negotiates before becoming active", async () => {
    const socket = new FakeSocket();
    const calls: unknown[] = [];
    const client = createRunnerWssClient({
      endpoint: "wss://collab.test/runner/v1",
      issueAccess: async () => ({
        accessToken: "a".repeat(48),
        proof: "signed-proof",
        nonce: "nonce_1",
      }),
      socketFactory(url, options) {
        calls.push({ url, options });
        return socket;
      },
      supportedRanges: [{ major: 1, minimumMinor: 0, maximumMinor: 1 }],
      onEnvelope: async () => undefined,
    });
    await client.start();
    expect(calls).toEqual([
      {
        url: "wss://collab.test/runner/v1",
        options: {
          headers: {
            authorization: `DPoP ${"a".repeat(48)}`,
            dpop: "signed-proof",
            "dpop-nonce": "nonce_1",
          },
        },
      },
    ]);
    socket.dispatchEvent(new Event("open"));
    expect(JSON.parse(socket.sent[0])).toEqual({
      kind: "CLIENT_HELLO",
      ranges: [{ major: 1, minimumMinor: 0, maximumMinor: 1 }],
    });
    expect(client.state).toBe("NEGOTIATING");
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          kind: "SERVER_WELCOME",
          selectedVersion: "1.1",
          connectionId: "connection_1",
          fence: 1,
          limits: {
            maximumFrameBytes: 65_536,
            runnerFramesPerSecond: 100,
            runnerBurst: 200,
            heartbeatSeconds: 10,
            offlineSeconds: 30,
          },
        }),
      }),
    );
    expect(client.state).toBe("ACTIVE");
  });

  test("rejects insecure or decorated endpoints before obtaining credentials", async () => {
    for (const endpoint of [
      "ws://collab.test/runner/v1",
      "wss://collab.test/runner/v1?token=x",
      "wss://user@collab.test/runner/v1",
      "wss://collab.test/other",
    ]) {
      let issued = 0;
      const client = createRunnerWssClient({
        endpoint,
        issueAccess: async () => {
          issued += 1;
          return { accessToken: "a".repeat(48), proof: "proof", nonce: "nonce" };
        },
        socketFactory: () => new FakeSocket(),
        supportedRanges: [{ major: 1, minimumMinor: 0, maximumMinor: 0 }],
        onEnvelope: async () => undefined,
      });
      expect(client.start()).rejects.toThrow("RUNNER_WSS_ENDPOINT_INVALID");
      expect(issued).toBe(0);
    }
  });
});
