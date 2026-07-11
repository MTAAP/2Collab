import { randomBytes } from "node:crypto";

type CloseReason = "FENCED" | "REVOKED" | "QUIESCE";
type Close = (reason: CloseReason) => void;

type Connection = Readonly<{
  connectionId: string;
  fence: number;
  close: Close;
}>;

export type RunnerTransportDisposition =
  | Readonly<{ kind: "KEEP_CONNECTION" }>
  | Readonly<{ kind: "REQUEST_TERMINATION"; attemptIds: readonly string[] }>
  | Readonly<{ kind: "CLOSE_RUNNER_IDENTITY" }>;

function connectionId(): string {
  return `connection_${randomBytes(24).toString("base64url")}`;
}

export class RunnerConnectionRegistry {
  readonly #connections = new Map<string, Connection>();
  readonly #fences = new Map<string, number>();
  #quiesced = false;

  register(runnerId: string, close: Close): Readonly<{ connectionId: string; fence: number }> {
    if (this.#quiesced) throw new Error("RUNNER_UPGRADES_QUIESCED");
    const previous = this.#connections.get(runnerId);
    const fence = (this.#fences.get(runnerId) ?? 0) + 1;
    const current = { connectionId: connectionId(), fence, close };
    this.#fences.set(runnerId, fence);
    this.#connections.set(runnerId, current);
    previous?.close("FENCED");
    return { connectionId: current.connectionId, fence };
  }

  isCurrent(runnerId: string, candidateConnectionId: string, fence: number): boolean {
    const current = this.#connections.get(runnerId);
    return current?.connectionId === candidateConnectionId && current.fence === fence;
  }

  unregister(runnerId: string, candidateConnectionId: string, fence: number): boolean {
    if (!this.isCurrent(runnerId, candidateConnectionId, fence)) return false;
    return this.#connections.delete(runnerId);
  }

  applyDisposition(
    runnerId: string,
    disposition: RunnerTransportDisposition,
  ):
    | Readonly<{ applied: boolean; closed: boolean }>
    | Readonly<{ applied: boolean; closed: false; requestedAttemptIds: readonly string[] }> {
    const current = this.#connections.get(runnerId);
    if (!current) return { applied: false, closed: false };
    if (disposition.kind === "KEEP_CONNECTION") return { applied: true, closed: false };
    if (disposition.kind === "REQUEST_TERMINATION") {
      return { applied: true, closed: false, requestedAttemptIds: [...disposition.attemptIds] };
    }
    this.#connections.delete(runnerId);
    current.close("REVOKED");
    return { applied: true, closed: true };
  }

  async quiesce(): Promise<Readonly<{ closed: number }>> {
    this.#quiesced = true;
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    for (const connection of connections) connection.close("QUIESCE");
    return { closed: connections.length };
  }
}
