import { describe, expect, test } from "bun:test";
import { RunnerConnectionRegistry } from "../../src/server/adapters/wss/connection-registry.ts";

describe("runner connection fencing and shutdown", () => {
  test("new connection fences the prior connection and quiesce closes all identities", async () => {
    const closed: string[] = [];
    const registry = new RunnerConnectionRegistry();
    const first = registry.register("runner_1", (reason) => closed.push(`first:${reason}`));
    const second = registry.register("runner_1", (reason) => closed.push(`second:${reason}`));
    expect(second.fence).toBe(first.fence + 1);
    expect(closed).toEqual(["first:FENCED"]);
    expect(registry.isCurrent("runner_1", first.connectionId, first.fence)).toBeFalse();
    expect(registry.isCurrent("runner_1", second.connectionId, second.fence)).toBeTrue();
    expect(await registry.quiesce()).toEqual({ closed: 1 });
    expect(closed).toEqual(["first:FENCED", "second:QUIESCE"]);
    expect(() => registry.register("runner_2", () => undefined)).toThrow(
      "RUNNER_UPGRADES_QUIESCED",
    );
  });

  test("typed revocation keeps, terminates, or closes the intended scope", () => {
    const effects: string[] = [];
    const registry = new RunnerConnectionRegistry();
    registry.register("runner_1", (reason) => effects.push(reason));
    expect(registry.applyDisposition("runner_1", { kind: "KEEP_CONNECTION" })).toEqual({
      applied: true,
      closed: false,
    });
    expect(
      registry.applyDisposition("runner_1", {
        kind: "REQUEST_TERMINATION",
        attemptIds: ["attempt_1"],
      }),
    ).toEqual({ applied: true, closed: false, requestedAttemptIds: ["attempt_1"] });
    expect(registry.applyDisposition("runner_1", { kind: "CLOSE_RUNNER_IDENTITY" })).toEqual({
      applied: true,
      closed: true,
    });
    expect(effects).toEqual(["REVOKED"]);
  });
});
