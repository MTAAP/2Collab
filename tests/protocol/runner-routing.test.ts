import { describe, expect, test } from "bun:test";
import { createRunnerInboundRouter } from "../../src/server/adapters/wss/inbound-router.ts";
import type { VerifiedRunnerPrincipal } from "../../src/shared/contracts/actors.ts";
import type { RunnerEnvelope } from "../../src/shared/contracts/protocol.ts";

const principal = {
  kind: "VERIFIED_RUNNER",
  runnerId: "runner_1",
  runnerEpoch: 4,
  ownerMemberId: "member_1",
  keyThumbprint: "thumbprint_1",
  accessExpiresAt: 2_000,
} as unknown as VerifiedRunnerPrincipal;

function envelope(
  body: RunnerEnvelope["body"],
  semanticContinuity?: RunnerEnvelope["semanticContinuity"],
): RunnerEnvelope {
  return {
    protocolVersion: "1.0",
    messageId: `message_${body.kind}`,
    sequence: 1,
    issuedAt: 1_000,
    expiresAt: 1_010,
    body,
    ...(semanticContinuity ? { semanticContinuity } : {}),
  };
}

describe("runner inbound semantic routing", () => {
  test("reconstructs principal and routes heartbeat, delivery, semantic events, and output separately", async () => {
    const calls: Array<readonly [string, unknown]> = [];
    const router = createRunnerInboundRouter({
      principal,
      currentFence: () => true,
      heartbeat: async (command) => {
        calls.push(["heartbeat", command]);
        return { ok: true, value: { disposition: "APPLIED" } };
      },
      acknowledgeDelivery: (deliveryId, digest) => {
        calls.push(["delivery", { deliveryId, digest }]);
        return { accepted: true };
      },
      acceptSemantic: async (body, actor) => {
        calls.push(["semantic", { body, actor }]);
        return { ok: true, value: { disposition: "APPLIED" } };
      },
      acceptOutput: (body) => {
        calls.push(["output", body]);
        return { accepted: true };
      },
      acceptGateEvent: async (body, actor) => {
        calls.push(["gate", { body, actor }]);
        return { ok: true, value: { accepted: true } };
      },
    });

    expect(await router.route(envelope({ kind: "HEARTBEAT" }))).toEqual({ accepted: true });
    expect(
      await router.route(
        envelope({
          kind: "OPERATION_ACKNOWLEDGEMENT",
          eventId: "event_delivery_1",
          deliveryId: "delivery_1",
          semanticDigest: "a".repeat(64),
        }),
      ),
    ).toEqual({ accepted: true });
    expect(
      await router.route(
        envelope(
          {
            kind: "ATTEMPT_EVENT",
            eventId: "event_attempt_1",
            payload: {
              runId: "run_1",
              expectedRunRevision: 1,
              attemptId: "attempt_1",
              expectedAttemptRevision: 1,
              event: { kind: "PROCESS_STARTED", observedAt: 1_000 },
            },
          },
          { localSequence: 1 },
        ),
      ),
    ).toEqual({ accepted: true, disposition: "APPLIED" });
    expect(
      await router.route(
        envelope({
          kind: "HEADLESS_OUTPUT_CHUNK",
          target: { kind: "ATTEMPT", attemptId: "attempt_1" },
          stream: "STDOUT",
          sequence: 1,
          redactionVersion: 1,
          text: "local-only",
          truncated: false,
        }),
      ),
    ).toEqual({ accepted: true });

    expect(calls[0]).toEqual(["heartbeat", { principal }]);
    expect(calls[2]).toEqual([
      "semantic",
      expect.objectContaining({
        actor: principal,
        body: expect.objectContaining({ kind: "ATTEMPT_EVENT" }),
      }),
    ]);
    expect(calls[3]?.[0]).toBe("output");
  });

  test("rechecks connection fence immediately before every semantic effect", async () => {
    let effects = 0;
    const router = createRunnerInboundRouter({
      principal,
      currentFence: () => false,
      heartbeat: async () => {
        effects += 1;
        return { ok: true, value: { accepted: true } };
      },
      acknowledgeDelivery: () => {
        effects += 1;
        return { accepted: true };
      },
      acceptSemantic: async () => {
        effects += 1;
        return { ok: true, value: { disposition: "APPLIED" } };
      },
      acceptOutput: () => {
        effects += 1;
        return { accepted: true };
      },
      acceptGateEvent: async () => {
        effects += 1;
        return { ok: true, value: { accepted: true } };
      },
    });
    expect(await router.route(envelope({ kind: "HEARTBEAT" }))).toEqual({
      accepted: false,
      code: "CONNECTION_FENCED",
    });
    expect(effects).toBe(0);
  });
});
