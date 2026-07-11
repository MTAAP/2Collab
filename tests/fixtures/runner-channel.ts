import {
  createInMemoryRunnerProtocolChannel,
  type RunnerEnvelope,
} from "../../src/server/adapters/wss/protocol.ts";

export const createInMemoryRunnerChannel = createInMemoryRunnerProtocolChannel;

export function validRunnerHeartbeat(override: Partial<RunnerEnvelope> = {}): RunnerEnvelope {
  return {
    protocolVersion: "1.0",
    messageId: "message_default",
    sequence: 1,
    issuedAt: 1_000,
    expiresAt: 1_010,
    body: { kind: "HEARTBEAT" },
    ...override,
  } as RunnerEnvelope;
}
