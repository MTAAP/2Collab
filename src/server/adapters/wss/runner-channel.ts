import type { ServerEnvelope } from "../../../shared/contracts/protocol.ts";
import { ServerEnvelopeSchema } from "../../../shared/contracts/protocol.ts";
import type { LiveOutputHub } from "./live-output.ts";
import { BoundedSendQueue } from "./rate-limits.ts";
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
  maximumSendQueueItems?: number;
  maximumSendQueueBytes?: number;
  liveOutput?: LiveOutputHub;
  scheduleTimeout?: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  onAcknowledgementTimeout?: (deliveryId: string, reason: "TIMEOUT" | "QUIESCED") => void;
  waitForDrain?: (deadline: number) => Promise<void>;
}>;

type QueuedEnvelope = Readonly<{ envelope: ServerEnvelope; operation: CommittedRunnerOperation }>;
type SendDisposition = "SENT" | "ENQUEUED" | "DROPPED" | "RETRY";

type AttachedConnection = Readonly<{
  connectionId: string;
  fence: number;
  send: (envelope: ServerEnvelope) => unknown;
  sequence: { value: number };
  queue: BoundedSendQueue<QueuedEnvelope>;
  transportPending: Map<string, CommittedRunnerOperation>;
}>;

type Pending = {
  operation: CommittedRunnerOperation;
  acknowledgeBy?: number;
  timeoutReported?: true;
  timer?: unknown;
};

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
  const drainWaiters = new Set<() => void>();

  const scheduleTimeout =
    dependencies.scheduleTimeout ??
    ((callback: () => void, milliseconds: number) => {
      const handle = setTimeout(callback, milliseconds);
      handle.unref?.();
      return handle;
    });
  const clearScheduled =
    dependencies.clearTimeout ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const waitForDrain =
    dependencies.waitForDrain ??
    ((deadline: number) =>
      new Promise<void>((resolve) => {
        const milliseconds = Math.max(0, deadline - dependencies.now()) * 1_000;
        if (milliseconds === 0) {
          resolve();
          return;
        }
        let timer: ReturnType<typeof setTimeout>;
        const done = () => {
          clearTimeout(timer);
          drainWaiters.delete(done);
          resolve();
        };
        timer = setTimeout(done, milliseconds);
        drainWaiters.add(done);
      }));

  const reportTimeout = (deliveryId: string, entry: Pending, reason: "TIMEOUT" | "QUIESCED") => {
    if (entry.timeoutReported === true) return false;
    entry.timeoutReported = true;
    dependencies.onAcknowledgementTimeout?.(deliveryId, reason);
    return true;
  };

  const markSent = (operation: CommittedRunnerOperation): void => {
    const prior = pending.get(operation.deliveryId);
    if (prior?.timer !== undefined) clearScheduled(prior.timer);
    const acknowledgeBy = Math.min(operation.expiresAt, dependencies.now() + 10);
    const entry: Pending = {
      operation,
      acknowledgeBy,
    };
    entry.timer = scheduleTimeout(
      () => {
        const current = pending.get(operation.deliveryId);
        if (
          current === entry &&
          current.acknowledgeBy !== undefined &&
          current.acknowledgeBy <= dependencies.now()
        ) {
          reportTimeout(operation.deliveryId, current, "TIMEOUT");
        }
      },
      Math.max(0, acknowledgeBy - dependencies.now()) * 1_000,
    );
    pending.set(operation.deliveryId, entry);
  };

  const sendDisposition = (value: unknown): SendDisposition => {
    if (value === false) return "RETRY";
    if (value === -1 || value === "ENQUEUED") return "ENQUEUED";
    if (value === 0 || value === "DROPPED") return "DROPPED";
    if (value === "RETRY") return "RETRY";
    return "SENT";
  };

  const sendOrQueue = (
    operation: CommittedRunnerOperation,
    envelope: ServerEnvelope,
    connection: AttachedConnection,
  ): boolean => {
    try {
      const disposition = sendDisposition(connection.send(envelope));
      if (disposition === "SENT") {
        markSent(operation);
        return true;
      }
      if (disposition === "ENQUEUED") {
        connection.transportPending.set(operation.deliveryId, operation);
        pending.set(operation.deliveryId, { operation });
        return false;
      }
      if (disposition === "DROPPED") {
        pending.set(operation.deliveryId, { operation });
        return false;
      }
    } catch {
      // A failed socket write remains a durable pending operation.
    }
    const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
    const critical = ["CANCEL_ATTEMPT", "CANCEL_GATE_EVALUATION"].includes(envelope.body.kind);
    connection.queue.enqueue({ envelope, operation }, bytes, critical ? "CRITICAL" : "NORMAL");
    pending.set(operation.deliveryId, { operation });
    return false;
  };

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
    const issuedAt = dependencies.now();
    const envelope: ServerEnvelope = {
      protocolVersion,
      messageId: dependencies.messageId(),
      sequence: connection.sequence.value,
      issuedAt,
      expiresAt: Math.min(operation.expiresAt, issuedAt + 5 * 60),
      body: operation.body,
    };
    if (!ServerEnvelopeSchema.safeParse(envelope).success) {
      throw new Error("COMMITTED_RUNNER_OPERATION_INVALID");
    }
    try {
      const sent = sendOrQueue(operation, envelope, connection);
      return {
        outboxId: operation.outboxId,
        deliveryId: operation.deliveryId,
        state: sent ? "SOCKET_SENT" : "UNREACHABLE",
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

  const flushConnection = (runnerId: string): number => {
    const connection = connections.get(runnerId);
    if (!connection) return 0;
    let sent = 0;
    while (connection.queue.size > 0) {
      const entry = connection.queue.peek();
      if (!entry) break;
      try {
        const disposition = sendDisposition(connection.send(entry.envelope));
        if (disposition === "RETRY") break;
        connection.queue.dequeue();
        if (disposition === "ENQUEUED") {
          connection.transportPending.set(entry.operation.deliveryId, entry.operation);
          continue;
        }
        if (disposition === "DROPPED") continue;
      } catch {
        break;
      }
      markSent(entry.operation);
      sent += 1;
    }
    return sent;
  };

  return {
    attach(
      runnerId: string,
      send: (envelope: ServerEnvelope) => unknown,
      close: (reason: "FENCED" | "REVOKED" | "QUIESCE") => void = () => undefined,
    ) {
      let registered: Readonly<{ connectionId: string; fence: number }> | undefined;
      registered = registry.register(runnerId, (reason) => {
        close(reason);
        const current = connections.get(runnerId);
        if (current && current.connectionId === registered?.connectionId) {
          connections.delete(runnerId);
        }
      });
      const connection: AttachedConnection = {
        ...registered,
        send,
        sequence: { value: 0 },
        queue: new BoundedSendQueue({
          maximumItems: dependencies.maximumSendQueueItems ?? 1_024,
          maximumBytes: dependencies.maximumSendQueueBytes ?? 1024 * 1024,
        }),
        transportPending: new Map(),
      };
      connections.set(runnerId, connection);
      return registered;
    },

    isCurrent(runnerId: string, connectionId: string, fence: number): boolean {
      return registry.isCurrent(runnerId, connectionId, fence);
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
      if (entry.timer !== undefined) clearScheduled(entry.timer);
      pending.delete(deliveryId);
      return { accepted: true as const, outboxId: entry.operation.outboxId };
    },

    pendingDeliveryIds(): readonly string[] {
      return [...pending.keys()].sort();
    },

    queuedEnvelopeCount(runnerId: string): number {
      return connections.get(runnerId)?.queue.size ?? 0;
    },

    transportPendingCount(runnerId: string): number {
      return connections.get(runnerId)?.transportPending.size ?? 0;
    },

    transportDrained(runnerId: string): number {
      const connection = connections.get(runnerId);
      if (!connection) return 0;
      const operations = [...connection.transportPending.values()];
      connection.transportPending.clear();
      for (const operation of operations) markSent(operation);
      return operations.length;
    },

    notifyDrain(): void {
      for (const resolve of [...drainWaiters]) resolve();
    },

    flush(runnerId: string): number {
      return flushConnection(runnerId);
    },

    sweepAcknowledgementTimeouts(): readonly string[] {
      const now = dependencies.now();
      const timedOut: string[] = [];
      for (const [deliveryId, entry] of pending) {
        if (
          entry.acknowledgeBy !== undefined &&
          entry.acknowledgeBy <= now &&
          entry.timeoutReported !== true
        ) {
          if (entry.timer !== undefined) clearScheduled(entry.timer);
          if (reportTimeout(deliveryId, entry, "TIMEOUT")) timedOut.push(deliveryId);
        }
      }
      return timedOut.sort();
    },

    async applyCommittedDisposition(runnerId: string, disposition: RunnerTransportDisposition) {
      const result = registry.applyDisposition(runnerId, disposition);
      if (result.closed) connections.delete(runnerId);
      return result;
    },

    async quiesce(deadline: number) {
      if (!Number.isFinite(deadline) || deadline < 0) {
        throw new Error("RUNNER_QUIESCE_DEADLINE_INVALID");
      }
      quiesced = true;
      const buffered = () =>
        [...connections.values()].some(
          (connection) => connection.queue.size > 0 || connection.transportPending.size > 0,
        );
      while (buffered() && dependencies.now() < deadline) {
        for (const runnerId of connections.keys()) flushConnection(runnerId);
        if (!buffered() || dependencies.now() >= deadline) break;
        await waitForDrain(deadline);
      }
      for (const connection of connections.values()) connection.queue.clear();
      for (const [deliveryId, entry] of pending) {
        if (entry.timer !== undefined) clearScheduled(entry.timer);
        reportTimeout(deliveryId, entry, "QUIESCED");
      }
      dependencies.liveOutput?.clearAll();
      const result = await registry.quiesce();
      connections.clear();
      return { closed: result.closed, pending: pending.size };
    },
  } satisfies RunnerControlPort & Record<string, unknown>;
}
