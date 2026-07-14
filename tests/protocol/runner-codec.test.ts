import { describe, expect, test } from "bun:test";
import { RunnerEnvelopeSchema, ServerEnvelopeSchema } from "../../src/shared/contracts/protocol.ts";
import { createInMemoryRunnerChannel, validRunnerHeartbeat } from "../fixtures/runner-channel.ts";

describe("runner wire codec", () => {
  test("rejects unknown kinds, binary, compression, invalid UTF-8, and oversized frames", () => {
    const channel = createInMemoryRunnerChannel({ active: true });
    expect(channel.receiveText('{"kind":"SHELL","command":"id"}')).toEqual({
      accepted: false,
      code: "FRAME_KIND_DENIED",
      close: true,
    });
    expect(channel.receiveBinary(new Uint8Array([1, 2, 3]))).toEqual({
      accepted: false,
      code: "BINARY_FRAME_DENIED",
      close: true,
    });
    expect(channel.receiveCompressed(new TextEncoder().encode("{}"))).toEqual({
      accepted: false,
      code: "COMPRESSED_FRAME_DENIED",
      close: true,
    });
    expect(channel.receiveBytes(new Uint8Array([0xc3, 0x28]))).toEqual({
      accepted: false,
      code: "FRAME_UTF8_INVALID",
      close: true,
    });
    expect(channel.receiveText(" ".repeat(65_537))).toEqual({
      accepted: false,
      code: "FRAME_TOO_LARGE",
      close: true,
    });
  });

  test("deduplicates identical envelopes and rejects changed replays and sequence regression", () => {
    const channel = createInMemoryRunnerChannel({ active: true });
    const frame = validRunnerHeartbeat({ messageId: "message_1", sequence: 1 });
    expect(channel.receiveText(JSON.stringify(frame))).toEqual({ accepted: true });
    expect(channel.receiveText(JSON.stringify(frame))).toEqual({ accepted: true, duplicate: true });
    expect(
      channel.receiveText(JSON.stringify({ ...frame, body: { ...frame.body, observedEpoch: 2 } })),
    ).toEqual({ accepted: false, code: "FRAME_ID_CONFLICT", close: true });
    expect(
      channel.receiveText(
        JSON.stringify(validRunnerHeartbeat({ messageId: "message_2", sequence: 1 })),
      ),
    ).toEqual({ accepted: false, code: "FRAME_SEQUENCE_REGRESSION", close: true });
  });

  test("measures UTF-8 bytes and enforces issue/expiry bounds", () => {
    const channel = createInMemoryRunnerChannel({ active: true, now: () => 1_000 });
    const frame = validRunnerHeartbeat({ messageId: "message_1", sequence: 1 });
    const padded = JSON.stringify({
      ...frame,
      body: { ...frame.body, padding: "é".repeat(33_000) },
    });
    expect(padded.length).toBeLessThan(65_536);
    expect(channel.receiveText(padded)).toEqual({
      accepted: false,
      code: "FRAME_TOO_LARGE",
      close: true,
    });
    expect(
      createInMemoryRunnerChannel({ active: true, now: () => 1_000 }).receiveText(
        JSON.stringify({ ...frame, issuedAt: 1_030, expiresAt: 1_031 }),
      ),
    ).toEqual({ accepted: true });
    expect(
      createInMemoryRunnerChannel({ active: true, now: () => 1_000 }).receiveText(
        JSON.stringify({ ...frame, issuedAt: 1_031, expiresAt: 1_032 }),
      ),
    ).toEqual({
      accepted: false,
      code: "FRAME_TIME_INVALID",
      close: true,
    });
    expect(
      createInMemoryRunnerChannel({ active: true, now: () => 1_000 }).receiveText(
        JSON.stringify({ ...frame, expiresAt: 1_000 }),
      ),
    ).toEqual({
      accepted: false,
      code: "FRAME_TIME_INVALID",
      close: true,
    });
    expect(
      createInMemoryRunnerChannel({ active: true, now: () => 1_000 }).receiveText(
        JSON.stringify({ ...frame, issuedAt: 1_000, expiresAt: 1_301 }),
      ),
    ).toEqual({ accepted: false, code: "FRAME_TIME_INVALID", close: true });
  });

  test("keeps both wire directions closed and denies local execution configuration", () => {
    const runner = validRunnerHeartbeat();
    expect(RunnerEnvelopeSchema.safeParse(runner).success).toBeTrue();
    expect(
      RunnerEnvelopeSchema.safeParse({
        ...runner,
        command: "git status",
        environment: { TOKEN: "x" },
      }).success,
    ).toBeFalse();

    const launch = {
      protocolVersion: "1.0",
      messageId: "message_launch",
      sequence: 1,
      issuedAt: 1_000,
      expiresAt: 1_010,
      body: {
        kind: "LAUNCH_ATTEMPT",
        deliveryId: "delivery_1",
        semanticDigest: "a".repeat(64),
        runId: "run_1",
        attemptId: "attempt_1",
        dispatchPermit: "p".repeat(32),
        goal: "Inspect the repository",
        instructions: {
          schemaVersion: 1,
          configurationDigest: "e".repeat(64),
          assemblyDigest: "f".repeat(64),
          contextEnvelopeDigest: "b".repeat(64),
          layers: { typedVariables: {}, runGoal: "Inspect the repository" },
        },
        bootstrap: {
          schemaVersion: 1,
          contextRecipe: { id: "recipe_1", version: 1, digest: "b".repeat(64) },
          references: [],
          omissions: [],
        },
        projectMappingRevision: 1,
        repositoryMode: "INSPECT_ONLY",
        repositoryAssurance: "ADVISORY",
        baseRevision: "c".repeat(40),
        host: "NATIVE",
        interaction: "HEADLESS",
        profileVersionId: "profile_1",
        profileFingerprint: "d".repeat(64),
        policyExpiresAt: 1_010,
        deadlineAt: 2_000,
      },
    };
    expect(ServerEnvelopeSchema.safeParse(launch).success).toBeTrue();
    expect(
      ServerEnvelopeSchema.safeParse({
        ...launch,
        body: {
          ...launch.body,
          command: "rm -rf /",
          arguments: ["--dangerous"],
          environment: { TOKEN: "secret" },
          localPath: "/private/repository",
        },
      }).success,
    ).toBeFalse();
  });
});
