import { describe, expect, test } from "bun:test";
import { LiveOutputHub } from "../../src/server/adapters/wss/live-output.ts";

describe("ephemeral runner output", () => {
  test("accepts only active headless work and marks sequence gaps and duplicates", () => {
    const hub = new LiveOutputHub({ maximumProcessBytes: 2_048, maximumTargetBytes: 1_024 });
    hub.activate("ATTEMPT", "attempt_1", "HEADLESS");
    expect(hub.accept("ATTEMPT", "attempt_1", "STDOUT", 1, "hello", 1, false)).toEqual({
      accepted: true,
      gap: false,
      truncated: false,
    });
    expect(hub.accept("ATTEMPT", "attempt_1", "STDOUT", 1, "hello", 1, false)).toEqual({
      accepted: true,
      duplicate: true,
      gap: false,
      truncated: false,
    });
    expect(hub.accept("ATTEMPT", "attempt_1", "STDOUT", 3, "later", 1, false)).toEqual({
      accepted: true,
      gap: true,
      truncated: false,
    });
    expect(hub.accept("ATTEMPT", "missing", "STDOUT", 1, "secret", 1, false)).toEqual({
      accepted: false,
      code: "OUTPUT_TARGET_INACTIVE",
    });
    hub.activate("ATTEMPT", "interactive", "INTERACTIVE");
    expect(hub.accept("ATTEMPT", "interactive", "STDOUT", 1, "no", 1, false)).toEqual({
      accepted: false,
      code: "OUTPUT_INTERACTIVE_DENIED",
    });
  });

  test("uses UTF-8 byte limits, redacts credential patterns, evicts oldest, and clears terminal work", () => {
    const hub = new LiveOutputHub({ maximumProcessBytes: 1_024, maximumTargetBytes: 512 });
    hub.activate("ATTEMPT", "attempt_1", "HEADLESS");
    expect(hub.accept("ATTEMPT", "attempt_1", "STDERR", 1, "é".repeat(8_193), 1, false)).toEqual({
      accepted: false,
      code: "OUTPUT_CHUNK_TOO_LARGE",
    });
    hub.accept("ATTEMPT", "attempt_1", "STDOUT", 1, `token ghp_${"a".repeat(40)}`, 1, false);
    expect(
      hub
        .inspect("ATTEMPT", "attempt_1")
        .map((chunk) => chunk.text)
        .join(""),
    ).not.toContain("ghp_");
    hub.accept("ATTEMPT", "attempt_1", "STDOUT", 2, "x".repeat(40), 1, false);
    expect(hub.inspect("ATTEMPT", "attempt_1").some((chunk) => chunk.evictedBefore)).toBeTrue();
    hub.clear("ATTEMPT", "attempt_1");
    expect(hub.inspect("ATTEMPT", "attempt_1")).toEqual([]);
  });

  test("bounds empty chunks and replay metadata under the same retained-memory ceiling", () => {
    const hub = new LiveOutputHub({ maximumProcessBytes: 1_200, maximumTargetBytes: 900 });
    hub.activate("ATTEMPT", "attempt_1", "HEADLESS");
    for (let sequence = 1; sequence <= 50_000; sequence += 1) {
      expect(
        hub.accept("ATTEMPT", "attempt_1", "STDOUT", sequence, "", 1, false).accepted,
      ).toBeTrue();
    }
    const retained = hub.inspect("ATTEMPT", "attempt_1");
    expect(retained.length).toBeLessThanOrEqual(3);
    expect(retained[0]?.evictedBefore).toBeTrue();
    expect(hub.accept("ATTEMPT", "attempt_1", "STDOUT", 1, "", 1, false)).toEqual({
      accepted: false,
      code: "OUTPUT_SEQUENCE_REGRESSION",
    });
  });
});
