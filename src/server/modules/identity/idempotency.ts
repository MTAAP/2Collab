import type { Database } from "bun:sqlite";
import { z } from "zod";
import { AuditIdSchema, DomainErrorSchema, type Result } from "../../../shared/contracts/result.ts";

const MAX_CANONICAL_INPUT_BYTES = 64 * 1024;
const MAX_CANONICAL_DEPTH = 16;
const MAX_CANONICAL_NODES = 4_096;

export type IdempotencyTicket = Readonly<{
  actorId: string;
  storageKey: string;
  inputHash: string;
}>;

const StoredSuccessSchema = z
  .object({ ok: z.literal(true), value: z.unknown(), auditId: AuditIdSchema.optional() })
  .strict()
  .refine((value) => Object.hasOwn(value, "value"), "Stored success value is required");
const StoredFailureSchema = z
  .object({ ok: z.literal(false), error: DomainErrorSchema, auditId: AuditIdSchema.optional() })
  .strict();
const StoredResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("RESULT"),
      result: z.union([StoredSuccessSchema, StoredFailureSchema]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("SECRET_ISSUED"),
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      message: z.string().min(1).max(240),
    })
    .strict(),
]);

type StoredResult = z.infer<typeof StoredResultSchema>;

type CanonicalState = {
  nodes: number;
  stringBytes: number;
  seen: WeakSet<object>;
};

function addString(state: CanonicalState, value: string): void {
  state.stringBytes += new TextEncoder().encode(value).length;
  if (state.stringBytes > MAX_CANONICAL_INPUT_BYTES) throw new Error("CANONICAL_LIMIT");
}

function canonicalize(value: unknown, state: CanonicalState, depth: number): unknown {
  if (depth > MAX_CANONICAL_DEPTH) throw new Error("CANONICAL_LIMIT");
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES) throw new Error("CANONICAL_LIMIT");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    addString(state, value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CANONICAL_UNSUPPORTED");
    return value;
  }
  if (typeof value !== "object") throw new Error("CANONICAL_UNSUPPORTED");
  if (state.seen.has(value)) throw new Error("CANONICAL_CYCLE");
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_CANONICAL_NODES - state.nodes) throw new Error("CANONICAL_LIMIT");
    const normalized: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      normalized.push(canonicalize(value[index], state, depth + 1));
    }
    return normalized;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("CANONICAL_UNSUPPORTED");
  }
  const record = value as Record<string, unknown>;
  const keys: string[] = [];
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    if (keys.length >= MAX_CANONICAL_NODES - state.nodes) throw new Error("CANONICAL_LIMIT");
    addString(state, key);
    keys.push(key);
  }
  keys.sort((left, right) => left.localeCompare(right));
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    normalized[key] = canonicalize(record[key], state, depth + 1);
  }
  return normalized;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function invalidInput(): Result<never> {
  return {
    ok: false,
    error: {
      code: "IDENTITY_INPUT_INVALID",
      message: "Identity input is invalid.",
      retry: "NEVER",
    },
  };
}

function invalidStorage(): Result<never> {
  return {
    ok: false,
    error: {
      code: "IDEMPOTENCY_STORAGE_INVALID",
      message: "Stored idempotency result is invalid.",
      retry: "NEVER",
    },
  };
}

export class IdentityIdempotency {
  constructor(
    private readonly database: Database,
    private readonly digest: (value: string) => Promise<Uint8Array>,
    private readonly clock: () => number,
    private readonly onInvalidStorage?: () => void,
  ) {}

  private invalidStorage<T>(): Result<T> {
    this.onInvalidStorage?.();
    return invalidStorage();
  }

  async ticket(
    operation: string,
    actorId: string,
    key: string,
    input: unknown,
  ): Promise<Result<IdempotencyTicket>> {
    if (
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(operation) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(key)
    ) {
      return invalidInput();
    }
    let canonical: string;
    try {
      const state: CanonicalState = { nodes: 0, stringBytes: 0, seen: new WeakSet() };
      canonical = JSON.stringify({
        input: canonicalize(input, state, 0),
        operation,
      });
      if (new TextEncoder().encode(canonical).length > MAX_CANONICAL_INPUT_BYTES) {
        return invalidInput();
      }
    } catch {
      return invalidInput();
    }
    return {
      ok: true,
      value: {
        actorId,
        storageKey: `${operation}:${key}`,
        inputHash: hex(await this.digest(canonical)),
      },
    };
  }

  replay<T>(ticket: IdempotencyTicket, valueSchema?: z.ZodType<T>): Result<T> | undefined {
    const row = this.database
      .query<{ input_hash: string; result_json: string }, [string, string]>(
        "SELECT input_hash, result_json FROM idempotency_results WHERE actor_id = ? AND idempotency_key = ?",
      )
      .get(ticket.actorId, ticket.storageKey);
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
    if (new TextEncoder().encode(row.result_json).length > MAX_CANONICAL_INPUT_BYTES) {
      return this.invalidStorage();
    }
    try {
      const parsed = StoredResultSchema.safeParse(JSON.parse(row.result_json));
      if (!parsed.success) return this.invalidStorage();
      const stored: StoredResult = parsed.data;
      if (stored.kind === "SECRET_ISSUED") {
        return {
          ok: false,
          error: { code: stored.code, message: stored.message, retry: "NEVER" },
        };
      }
      if (!stored.result.ok) return stored.result;
      if (!valueSchema) return this.invalidStorage();
      const value = valueSchema.safeParse(stored.result.value);
      if (!value.success) return this.invalidStorage();
      return {
        ok: true,
        value: value.data,
        ...(stored.result.auditId ? { auditId: stored.result.auditId } : {}),
      };
    } catch {
      return this.invalidStorage();
    }
  }

  storeResult<T>(ticket: IdempotencyTicket, result: Result<T>): void {
    this.insert(ticket, { kind: "RESULT", result });
  }

  storeSecretIssued(ticket: IdempotencyTicket, code: string, message: string): void {
    this.insert(ticket, { kind: "SECRET_ISSUED", code, message });
  }

  private insert(ticket: IdempotencyTicket, result: StoredResult): void {
    this.database
      .query<void, [string, string, string, string, number]>(
        "INSERT INTO idempotency_results(actor_id, idempotency_key, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        ticket.actorId,
        ticket.storageKey,
        ticket.inputHash,
        JSON.stringify(result),
        this.clock(),
      );
  }
}
