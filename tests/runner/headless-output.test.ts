import { describe, expect, test } from "bun:test";
import { createCodexExecutionAdapter } from "../../src/runner/adapters/runtime/codex.ts";
import { createHeadlessOutputProducer } from "../../src/runner/headless-output.ts";
import { RunnerEnvelopeSchema, type RunnerEnvelope } from "../../src/shared/contracts/protocol.ts";

describe("headless runtime output producer", () => {
  test("redacts split secrets per stream and flushes them through real outbound envelopes", async () => {
    const sent: RunnerEnvelope[] = [];
    let message = 0;
    const producer = createHeadlessOutputProducer({
      adapter: createCodexExecutionAdapter(),
      target: { kind: "ATTEMPT", attemptId: "attempt_1" },
      protocolVersion: "1.0",
      now: () => 1_000,
      messageId: () => `message_${++message}`,
      send: async (envelope) => {
        sent.push(RunnerEnvelopeSchema.parse(envelope));
      },
    });

    expect(producer.push({ kind: "STDOUT", text: "before ghp_aaaaaaaaaa" })).toMatchObject({
      ok: true,
    });
    expect(
      producer.push({ kind: "STDERR", text: "Authorization: Bearer separate-secret-value" }),
    ).toMatchObject({ ok: true });
    expect(
      producer.push({ kind: "STDOUT", text: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa after" }),
    ).toMatchObject({ ok: true });
    expect(
      producer.push({ kind: "STDOUT", text: "\n-----BEGIN RSA PRIVATE KEY-----\nprivate" }),
    ).toMatchObject({ ok: true });
    expect(
      producer.push({ kind: "STDOUT", text: "-material\n-----END RSA PRIVATE KEY-----\ndone" }),
    ).toMatchObject({ ok: true });
    await producer.finish();

    const wire = JSON.stringify(sent);
    expect(wire).not.toContain("ghp_");
    expect(wire).not.toContain("separate-secret-value");
    expect(wire).not.toContain("private-material");
    expect(wire).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(wire).toContain("Authorization: Bearer [REDACTED]");
    expect(wire).toContain("[REDACTED_PRIVATE_KEY]");
    expect(sent.every((entry) => entry.body.kind === "HEADLESS_OUTPUT_CHUNK")).toBeTrue();
    expect(sent.map((entry) => entry.sequence)).toEqual(sent.map((_, index) => index + 1));
  });

  test("bounds queued runtime output while a slow outbound send is active", async () => {
    let release: (() => void) | undefined;
    const producer = createHeadlessOutputProducer({
      adapter: createCodexExecutionAdapter(),
      target: { kind: "ATTEMPT", attemptId: "attempt_1" },
      protocolVersion: "1.0",
      now: () => 1_000,
      messageId: () => "message_1",
      maximumPendingItems: 2,
      maximumPendingBytes: 400,
      redactionHoldbackBytes: 128,
      send: async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    expect(producer.push({ kind: "STDOUT", text: "a".repeat(200) })).toMatchObject({ ok: true });
    expect(producer.push({ kind: "STDOUT", text: "b".repeat(200) })).toMatchObject({ ok: true });
    expect(producer.push({ kind: "STDOUT", text: "c".repeat(200) })).toMatchObject({
      ok: false,
      error: { code: "OUTPUT_BACKPRESSURE" },
    });
    release?.();
  });
});
