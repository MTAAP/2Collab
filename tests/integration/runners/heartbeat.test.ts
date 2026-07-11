import { describe, expect, test } from "bun:test";
import { createRunnerFixture } from "./runner-fixture.ts";

describe("runner heartbeat", () => {
  test("derives never-connected, online, offline, and revoked state from server time", async () => {
    const fixture = createRunnerFixture();
    try {
      const paired = await fixture.pair("member_a");
      expect(fixture.registry.inspectLease(paired.runnerId)).toMatchObject({
        state: "NEVER_CONNECTED",
      });
      const authenticated = await fixture.authenticate(paired, "heartbeat_1");
      const callerStatus = await fixture.registry.heartbeat({
        idempotencyKey: "invalid_heartbeat",
        principal: authenticated.principal,
        status: "ONLINE",
        observedAt: 0,
      } as never);
      expect(callerStatus.ok).toBeFalse();
      await fixture.registry.heartbeat({
        idempotencyKey: "valid_heartbeat",
        principal: authenticated.principal,
      });
      fixture.setNow(fixture.now() + 29);
      expect(fixture.registry.inspectLease(paired.runnerId).state).toBe("ONLINE");
      fixture.setNow(fixture.now() + 1);
      expect(fixture.registry.inspectLease(paired.runnerId).state).toBe("OFFLINE");
    } finally {
      fixture.close();
    }
  });
});
