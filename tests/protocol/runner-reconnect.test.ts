import { describe, expect, test } from "bun:test";
import { RunnerReconnectState } from "../../src/runner/transport/reconnect.ts";

describe("runner reconnect", () => {
  test("backs off with a cap and resets only after a stable welcome", () => {
    const reconnect = new RunnerReconnectState({ jitter: () => 1 });
    expect(reconnect.state).toBe("DISCONNECTED");
    reconnect.authenticating();
    reconnect.negotiating();
    reconnect.active(1_000);
    reconnect.disconnected("NETWORK", 1_001);
    expect(reconnect.state).toBe("BACKING_OFF");
    expect(reconnect.nextDelaySeconds()).toBe(1);
    reconnect.retrying();
    reconnect.disconnected("UNAVAILABLE", 1_002);
    expect(reconnect.nextDelaySeconds()).toBe(2);
    for (let index = 0; index < 10; index += 1) {
      reconnect.retrying();
      reconnect.disconnected("NETWORK", 2_000 + index);
    }
    expect(reconnect.nextDelaySeconds()).toBe(30);
    reconnect.retrying();
    reconnect.active(3_000);
    reconnect.markStable(3_031);
    reconnect.disconnected("NETWORK", 3_032);
    expect(reconnect.nextDelaySeconds()).toBe(1);
  });

  test("does not retry permanent authentication or protocol failures", () => {
    for (const reason of ["AUTHENTICATION", "PROTOCOL", "POLICY"] as const) {
      const reconnect = new RunnerReconnectState();
      reconnect.authenticating();
      reconnect.disconnected(reason, 0);
      expect(reconnect.state).toBe("STOPPED");
      expect(reconnect.nextDelaySeconds()).toBeNull();
    }
  });

  test("an explicit stop is terminal even if the socket later closes", () => {
    const reconnect = new RunnerReconnectState();
    reconnect.authenticating();
    reconnect.negotiating();
    reconnect.active(0);
    reconnect.stop();
    reconnect.disconnected("NETWORK", 1);
    expect(reconnect.state).toBe("STOPPED");
    expect(reconnect.nextDelaySeconds()).toBeNull();
  });
});
