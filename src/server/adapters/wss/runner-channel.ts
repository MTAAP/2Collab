import type { ServerEnvelope } from "../../../shared/contracts/protocol.ts";
import { ServerEnvelopeSchema } from "../../../shared/contracts/protocol.ts";
import {
  RunnerConnectionRegistry,
  type RunnerTransportDisposition,
} from "./connection-registry.ts";

export type CommittedRunnerOperation = Readonly<{
  outboxId: string;
  runnerId: string;
  deliveryId: string;
  semanticDigest: string;
  expiresAt: number;
  body: ServerEnvelope["body"];
}>;

export type DeliveryReceipt = Readonly<{
  outboxId: string;
  deliveryId?: string;
  state: "SOCKET_SENT" | "UNREACHABLE" | "NOT_COMMITTED" | "EXPIRED" | "QUIESCED";
}>;

type Dependencies = Readonly<{
  now: () => number;
  messageId: () => string;
  loadCommitted: (outboxIds: readonly string[]) => readonly CommittedRunnerOperation[];
  protocolVersion?: string;
}>;

type AttachedConnection = Readonly<{
  connectionId: string;
  fence: number;
  send: (envelope: ServerEnvelope) => void;
  sequence: { value: number };
}>;

type Pending = Readonly<{ operation: CommittedRunnerOperation }>;

export interface RunnerControlPort {
  dispatchCommitted(outboxIds: readonly string[]): Promise<readonly DeliveryReceipt[]>;
  applyCommittedDisposition(
    runnerId: string,
    disposition: RunnerTransportDisposition,
  ): Promise<Readonly<{ applied: boolean; closed: boolean }>>;
  quiesce(deadline: number): Promise<Readonly<{ closed: number; pending: number }>>;
}

export function createRunnerChannel(dependencies: Dependencies) {
  const registry = new RunnerConnectionRegistry();
  const connections = new Map<string, AttachedConnection>();
  const pending = new Map<string, Pending>();
  const protocolVersion = dependencies.protocolVersion ?? "1.0";
  let quiesced = false;

  const transmit = (
    operation: CommittedRunnerOperation,
    connection: AttachedConnection,
  ): DeliveryReceipt => {
    if (quiesced) {
      return {
        outboxId: operation.outboxId,
        deliveryId: operation.deliveryId,
        state: "QUIESCED",
      };
    }
    if (operation.expiresAt <= dependencies.now()) {
      return {
        outboxId: operation.outboxId,
        deliveryId: operation.deliveryId,
        state: "EXPIRED",
      };
    }
    connection.sequence.value += 1;
    const envelope: ServerEnvelope = {
      protocolVersion,
      messageId: dependencies.messageId(),
      sequence: connection.sequence.value,
      issuedAt: dependencies.now(),
      expiresAt: operation.expiresAt,
      body: operation.body,
    };
    if (!ServerEnvelopeSchema.safeParse(envelope).success) {
      throw new Error("COMMITTED_RUNNER_OPERATION_INVALID");
    }
    try {
      connection.send(envelope);
      pending.set(operation.deliveryId, { operation });
      return {
        outboxId: operation.outboxId,
        deliveryId: operation.deliveryId,
        state: "SOCKET_SENT",
      };
    } catch {
      pending.set(operation.deliveryId, { operation });
      return {
        outboxId: operation.outboxId,
        deliveryId: operation.deliveryId,
        state: "UNREACHABLE",
      };
    }
  };

  return {
    attach(runnerId: string, send: (envelope: ServerEnvelope) => void) {
      let registered: Readonly<{ connectionId: string; fence: number }> | undefined;
      registered = registry.register(runnerId, () => {
        const current = connections.get(runnerId);
        if (current && current.connectionId === registered?.connectionId) {
          connections.delete(runnerId);
        }
      });
      const connection: AttachedConnection = {
        ...registered,
        send,
        sequence: { value: 0 },
      };
      connections.set(runnerId, connection);
      return registered;
    },

    detach(runnerId: string, connectionId: string, fence: number): boolean {
      const removed = registry.unregister(runnerId, connectionId, fence);
      if (removed && connections.get(runnerId)?.connectionId === connectionId) {
        connections.delete(runnerId);
      }
      return removed;
    },

    async dispatchCommitted(outboxIds: readonly string[]): Promise<readonly DeliveryReceipt[]> {
      const committed = new Map(
        dependencies.loadCommitted(outboxIds).map((operation) => [operation.outboxId, operation]),
      );
      return outboxIds.map((outboxId) => {
        const operation = committed.get(outboxId);
        if (!operation) return { outboxId, state: "NOT_COMMITTED" } as const;
        if (quiesced) {
          return {
            outboxId,
            deliveryId: operation.deliveryId,
            state: "QUIESCED",
          } as const;
        }
        if (operation.expiresAt <= dependencies.now()) {
          return {
            outboxId,
            deliveryId: operation.deliveryId,
            state: "EXPIRED",
          } as const;
        }
        const connection = connections.get(operation.runnerId);
        if (!connection) {
          pending.set(operation.deliveryId, { operation });
          return {
            outboxId,
            deliveryId: operation.deliveryId,
            state: "UNREACHABLE",
          } as const;
        }
        return transmit(operation, connection);
      });
    },

    async resendPending(runnerId: string): Promise<readonly DeliveryReceipt[]> {
      const connection = connections.get(runnerId);
      if (!connection) return [];
      return [...pending.values()]
        .map((entry) => entry.operation)
        .filter((operation) => operation.runnerId === runnerId)
        .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId))
        .map((operation) => transmit(operation, connection));
    },

    acknowledge(runnerId: string, deliveryId: string, semanticDigest: string) {
      const entry = pending.get(deliveryId);
      if (!entry || entry.operation.runnerId !== runnerId) {
        return { accepted: false as const, code: "DELIVERY_NOT_PENDING" };
      }
      if (entry.operation.semanticDigest !== semanticDigest) {
        return { accepted: false as const, code: "DELIVERY_DIGEST_CONFLICT" };
      }
      pending.delete(deliveryId);
      return { accepted: true as const, outboxId: entry.operation.outboxId };
    },

    pendingDeliveryIds(): readonly string[] {
      return [...pending.keys()].sort();
    },

    async applyCommittedDisposition(runnerId: string, disposition: RunnerTransportDisposition) {
      const result = registry.applyDisposition(runnerId, disposition);
      if (result.closed) connections.delete(runnerId);
      return result;
    },

    async quiesce(_deadline: number) {
      quiesced = true;
      const result = await registry.quiesce();
      connections.clear();
      return { closed: result.closed, pending: pending.size };
    },
  } satisfies RunnerControlPort & Record<string, unknown>;
}
