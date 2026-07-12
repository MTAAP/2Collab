import { describe, expect, test } from "bun:test";
import { SplitSafeRedactor } from "../../src/runner/redaction.ts";

describe("split-safe local output redaction", () => {
  test("never emits a credential that crosses chunk boundaries", () => {
    const redactor = new SplitSafeRedactor();
    const output = [
      redactor.push("STDOUT", "before ghp_aaaaaaaaaa"),
      redactor.push("STDOUT", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa after"),
      redactor.flush("STDOUT"),
    ].join("");
    expect(output).toBe("before [REDACTED_GITHUB_TOKEN] after");
    expect(output).not.toContain("ghp_");
  });

  test("keeps stream state separate and bounds delayed text", () => {
    const redactor = new SplitSafeRedactor({ holdbackBytes: 128 });
    const stdout = redactor.push("STDOUT", "x".repeat(1_024));
    expect(Buffer.byteLength(stdout, "utf8")).toBeGreaterThanOrEqual(896);
    expect(Buffer.byteLength(redactor.flush("STDOUT"), "utf8")).toBeLessThanOrEqual(128);
    redactor.push("STDERR", "Authorization: Bearer secret-value-with-enough-length");
    expect(redactor.flush("STDERR")).toBe("Authorization: Bearer [REDACTED]");
  });
});
