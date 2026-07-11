import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { Result } from "../shared/contracts/result.ts";

const CacheFactSchema = z
  .object({
    cacheKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    factKind: z.enum(["SOURCE_REVISION", "CONTEXT_REFERENCE", "POLICY_FACT"]),
    sourceId: z.string().min(1).max(256),
    sourceRevision: z.string().min(1).max(128),
    valueCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    provenanceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    observedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type ContinuityCacheFact = Readonly<z.infer<typeof CacheFactSchema>>;

type Limits = Readonly<{
  maximumItems: number;
  maximumBytes: number;
  maximumRunBytes: number;
  maximumAgeSeconds: number;
}>;

const defaults: Limits = {
  maximumItems: 50_000,
  maximumBytes: 64 * 1024 * 1024,
  maximumRunBytes: 4 * 1024 * 1024,
  maximumAgeSeconds: 7 * 86_400,
};

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

function byteCount(fact: ContinuityCacheFact): number {
  return Buffer.byteLength(
    [
      fact.cacheKey,
      fact.runId,
      fact.factKind,
      fact.sourceId,
      fact.sourceRevision,
      fact.valueCode,
      fact.provenanceId,
    ].join("\0"),
    "utf8",
  );
}

export function createRunnerContinuityCache(
  database: Database,
  clock: () => number,
  configured: Partial<Limits> = {},
) {
  const limits = { ...defaults, ...configured };
  if (
    !Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0) ||
    limits.maximumBytes > defaults.maximumBytes ||
    limits.maximumRunBytes > defaults.maximumRunBytes ||
    limits.maximumAgeSeconds > defaults.maximumAgeSeconds
  ) {
    throw new Error("CONTINUITY_CACHE_LIMIT_INVALID");
  }
  return {
    put(candidate: ContinuityCacheFact): Result<ContinuityCacheFact> {
      const parsed = CacheFactSchema.safeParse(candidate);
      if (
        !parsed.success ||
        parsed.data.expiresAt <= parsed.data.observedAt ||
        parsed.data.expiresAt - parsed.data.observedAt > limits.maximumAgeSeconds
      ) {
        return failure("CONTINUITY_CACHE_FACT_INVALID", "Continuity cache fact is invalid.");
      }
      const fact = parsed.data;
      const bytes = byteCount(fact);
      if (bytes < 1 || bytes > 16_384) {
        return failure("CONTINUITY_CACHE_FACT_INVALID", "Continuity cache fact is invalid.");
      }
      const existing = database
        .query<{ byte_count: number; run_id: string }, [string]>(
          "SELECT byte_count, run_id FROM local_continuity_cache WHERE cache_key = ?",
        )
        .get(fact.cacheKey);
      const totals = database
        .query<{ items: number; bytes: number }, []>(
          "SELECT count(*) AS items, coalesce(sum(byte_count), 0) AS bytes FROM local_continuity_cache",
        )
        .get();
      const runBytes =
        database
          .query<{ bytes: number }, [string]>(
            "SELECT coalesce(sum(byte_count), 0) AS bytes FROM local_continuity_cache WHERE run_id = ?",
          )
          .get(fact.runId)?.bytes ?? 0;
      const oldBytes = existing?.byte_count ?? 0;
      if (
        (existing === undefined && (totals?.items ?? 0) >= limits.maximumItems) ||
        (totals?.bytes ?? 0) - oldBytes + bytes > limits.maximumBytes ||
        runBytes - (existing?.run_id === fact.runId ? oldBytes : 0) + bytes > limits.maximumRunBytes
      ) {
        return failure("CONTINUITY_CACHE_FULL", "Continuity cache limit was reached.");
      }
      const now = Math.floor(clock());
      try {
        database
          .query(
            `INSERT INTO local_continuity_cache(
               cache_key, run_id, fact_kind, source_id, source_revision, value_code,
               provenance_id, byte_count, observed_at, expires_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(cache_key) DO UPDATE SET
               run_id = excluded.run_id, fact_kind = excluded.fact_kind,
               source_id = excluded.source_id, source_revision = excluded.source_revision,
               value_code = excluded.value_code, provenance_id = excluded.provenance_id,
               byte_count = excluded.byte_count, observed_at = excluded.observed_at,
               expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
          )
          .run(
            fact.cacheKey,
            fact.runId,
            fact.factKind,
            fact.sourceId,
            fact.sourceRevision,
            fact.valueCode,
            fact.provenanceId,
            bytes,
            fact.observedAt,
            fact.expiresAt,
            now,
            now,
          );
        return { ok: true, value: fact };
      } catch {
        return failure("CONTINUITY_CACHE_STATE_FAILED", "Continuity cache state failed.");
      }
    },

    read(
      cacheKey: string,
    ): Result<Readonly<{ freshness: "FRESH" | "STALE"; fact: ContinuityCacheFact }>> {
      const row = database
        .query<
          {
            cache_key: string;
            run_id: string;
            fact_kind: ContinuityCacheFact["factKind"];
            source_id: string;
            source_revision: string;
            value_code: string;
            provenance_id: string;
            observed_at: number;
            expires_at: number;
          },
          [string]
        >("SELECT * FROM local_continuity_cache WHERE cache_key = ?")
        .get(cacheKey);
      if (!row)
        return failure("CONTINUITY_CACHE_NOT_FOUND", "Continuity cache fact was not found.");
      return {
        ok: true,
        value: {
          freshness: clock() < row.expires_at ? "FRESH" : "STALE",
          fact: {
            cacheKey: row.cache_key,
            runId: row.run_id,
            factKind: row.fact_kind,
            sourceId: row.source_id,
            sourceRevision: row.source_revision,
            valueCode: row.value_code,
            provenanceId: row.provenance_id,
            observedAt: row.observed_at,
            expiresAt: row.expires_at,
          },
        },
      };
    },

    purgeExpired(): Readonly<{ purged: number }> {
      const boundary = Math.floor(clock()) - limits.maximumAgeSeconds;
      const result = database
        .query("DELETE FROM local_continuity_cache WHERE expires_at <= ? OR observed_at <= ?")
        .run(Math.floor(clock()), boundary);
      return { purged: result.changes };
    },
  };
}
