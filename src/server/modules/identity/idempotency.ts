import type { Database } from "bun:sqlite";
import type { Result } from "../../../shared/contracts/result.ts";

const MAX_CANONICAL_INPUT_BYTES = 64 * 1024;

export type IdempotencyTicket = Readonly<{
  actorId: string;
  key: string;
  inputHash: string;
}>;

type StoredResult =
  | Readonly<{ kind: "RESULT"; result: Result<unknown> }>
  | Readonly<{ kind: "SECRET_ISSUED"; code: string; message: string }>;

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("base64url") };
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export class IdentityIdempotency {
  constructor(
    private readonly database: Database,
    private readonly digest: (value: string) => Promise<Uint8Array>,
    private readonly clock: () => number,
  ) {}

  async ticket(actorId: string, key: string, input: unknown): Promise<Result<IdempotencyTicket>> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(key)) {
      return {
        ok: false,
        error: {
          code: "IDENTITY_INPUT_INVALID",
          message: "Identity input is invalid.",
          retry: "NEVER",
        },
      };
    }
    let canonical: string;
    try {
      canonical = JSON.stringify(canonicalize(input));
    } catch {
      return {
        ok: false,
        error: {
          code: "IDENTITY_INPUT_INVALID",
          message: "Identity input is invalid.",
          retry: "NEVER",
        },
      };
    }
    if (new TextEncoder().encode(canonical).length > MAX_CANONICAL_INPUT_BYTES) {
      return {
        ok: false,
        error: {
          code: "IDENTITY_INPUT_INVALID",
          message: "Identity input is invalid.",
          retry: "NEVER",
        },
      };
    }
    return { ok: true, value: { actorId, key, inputHash: hex(await this.digest(canonical)) } };
  }

  replay<T>(ticket: IdempotencyTicket): Result<T> | undefined {
    const row = this.database
      .query<{ input_hash: string; result_json: string }, [string, string]>(
        "SELECT input_hash, result_json FROM idempotency_results WHERE actor_id = ? AND idempotency_key = ?",
      )
      .get(ticket.actorId, ticket.key);
    if (!row) return undefined;
    if (row.input_hash !== ticket.inputHash) {
      return {
        ok: false,
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "Idempotency key was already used with different input.",
          retry: "NEVER",
        },
      };
    }
    const stored = JSON.parse(row.result_json) as StoredResult;
    if (stored.kind === "SECRET_ISSUED") {
      return {
        ok: false,
        error: { code: stored.code, message: stored.message, retry: "NEVER" },
      };
    }
    return stored.result as Result<T>;
  }

  storeResult<T>(ticket: IdempotencyTicket, result: Result<T>): void {
    this.insert(ticket, { kind: "RESULT", result: result as Result<unknown> });
  }

  storeSecretIssued(ticket: IdempotencyTicket, code: string, message: string): void {
    this.insert(ticket, { kind: "SECRET_ISSUED", code, message });
  }

  private insert(ticket: IdempotencyTicket, result: StoredResult): void {
    this.database
      .query<void, [string, string, string, string, number]>(
        "INSERT INTO idempotency_results(actor_id, idempotency_key, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(ticket.actorId, ticket.key, ticket.inputHash, JSON.stringify(result), this.clock());
  }
}
