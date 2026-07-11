import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunnerContinuityCache } from "../../src/runner/cache.ts";
import { openRunnerDatabase } from "../../src/runner/db/connection.ts";
import { decideOffline } from "../../src/runner/offline-policy.ts";
import { createRunnerSemanticOutbox } from "../../src/runner/outbox.ts";
import { createRunnerEventDeduplicator } from "../../src/server/modules/runs/event-deduplication.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("mutation stops after grace while inspect-only continues only to its deadline", () => {
  const base = {
    connectedAndRenewed: false,
    disconnectedAt: 100,
    now: 115,
    attemptDeadline: 200,
    authoritySessionExpiresAt: 160,
    disconnectGraceSeconds: 15,
  } as const;
  expect(decideOffline({ ...base, mode: "MUTATING", mutationLeaseExpiresAt: 170 })).toEqual({
    action: "CHECKPOINT_AND_STOP",
    code: "MUTATION_LEASE_EXPIRED",
  });
  expect(
    decideOffline({ ...base, now: 114, mode: "MUTATING", mutationLeaseExpiresAt: 170 }),
  ).toEqual({
    action: "CONTINUE_MUTATION_WITH_EXISTING_LEASE",
  });
  expect(decideOffline({ ...base, mode: "INSPECT_ONLY" })).toEqual({
    action: "CONTINUE_INSPECTION",
  });
  expect(decideOffline({ ...base, now: 161, mode: "INSPECT_ONLY" })).toEqual({
    action: "CONTINUE_INSPECTION",
  });
  expect(
    decideOffline({ ...base, now: 161, mode: "MUTATING", mutationLeaseExpiresAt: 170 }),
  ).toEqual({ action: "CHECKPOINT_AND_STOP", code: "AUTHORITY_SESSION_EXPIRED" });
  expect(decideOffline({ ...base, now: 200, mode: "INSPECT_ONLY" })).toEqual({
    action: "CHECKPOINT_AND_STOP",
    code: "ATTEMPT_DEADLINE_EXPIRED",
  });
  expect(
    decideOffline({
      ...base,
      mode: "MUTATING",
      mutationLeaseExpiresAt: undefined,
    }),
  ).toEqual({ action: "CHECKPOINT_AND_STOP", code: "MUTATION_LEASE_MISSING" });
});

test("continuity cache is provenance-bound, stale-aware, bounded, and contains no authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-continuity-cache-"));
  directories.push(directory);
  const database = openRunnerDatabase(join(directory, "runner.db"));
  let now = 1_000;
  const cache = createRunnerContinuityCache(database, () => now, {
    maximumItems: 2,
    maximumBytes: 2_048,
    maximumRunBytes: 1_024,
    maximumAgeSeconds: 7 * 86_400,
  });
  expect(
    cache.put({
      cacheKey: "fact_1",
      runId: "run_1",
      factKind: "SOURCE_REVISION",
      sourceId: "issue_1",
      sourceRevision: "etag_1",
      valueCode: "OPEN",
      provenanceId: "github_1",
      observedAt: now,
      expiresAt: now + 60,
    }),
  ).toMatchObject({ ok: true });
  expect(cache.read("fact_1")).toMatchObject({
    ok: true,
    value: { freshness: "FRESH", fact: { sourceRevision: "etag_1" } },
  });
  now += 61;
  expect(cache.read("fact_1")).toMatchObject({ ok: true, value: { freshness: "STALE" } });
  expect(
    cache.put({
      cacheKey: "secret_1",
      runId: "run_1",
      factKind: "AUTHORITY_SESSION" as never,
      sourceId: "session_1",
      sourceRevision: "1",
      valueCode: "ACTIVE",
      provenanceId: "server_1",
      observedAt: now,
      expiresAt: now + 60,
    }),
  ).toMatchObject({ ok: false, error: { code: "CONTINUITY_CACHE_FACT_INVALID" } });
  const schema = database
    .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.sql)
    .join("\n")
    .toLowerCase();
  for (const prohibited of [
    "permit",
    "authority_session",
    "raw_output",
    "prompt",
    "transcript",
    "source_body",
    "diff_text",
    "environment_json",
    "absolute_path",
  ]) {
    expect(schema).not.toContain(prohibited);
  }
  database.close();
});

test("semantic outbox preserves causal identity and terminal reserve across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-continuity-outbox-"));
  directories.push(directory);
  const path = join(directory, "runner.db");
  let database = openRunnerDatabase(path);
  let outbox = createRunnerSemanticOutbox(database, () => 1_000, {
    maximumItems: 3,
    maximumBytes: 65_536,
    reservedCriticalItems: 1,
    reservedCriticalBytes: 8_192,
  });
  const evidence = (eventId: string, evidenceId: string) => ({
    eventId,
    runId: "run_1",
    body: {
      kind: "EVIDENCE" as const,
      eventId,
      payload: {
        runId: "run_1",
        expectedRunRevision: 1,
        attemptId: "attempt_1",
        evidence: {
          kind: "VERIFICATION" as const,
          name: evidenceId,
          outcome: "PASSED" as const,
          durationMs: 1,
          summary: "Verification passed.",
        },
      },
    },
  });
  expect(outbox.enqueue(evidence("event_1", "check_1"))).toMatchObject({
    ok: true,
    value: { localSequence: 1, state: "PENDING" },
  });
  expect(outbox.enqueue(evidence("event_2", "check_2"))).toMatchObject({
    ok: true,
    value: { localSequence: 2, predecessorEventId: "event_1" },
  });
  expect(outbox.enqueue(evidence("event_3", "check_3"))).toMatchObject({
    ok: false,
    error: { code: "RUNNER_OUTBOX_RESERVED_CAPACITY" },
  });
  const terminal = {
    eventId: "event_terminal",
    runId: "run_1",
    body: {
      kind: "ATTEMPT_EVENT" as const,
      eventId: "event_terminal",
      payload: {
        runId: "run_1",
        expectedRunRevision: 1,
        attemptId: "attempt_1",
        expectedAttemptRevision: 1,
        event: { kind: "LOST" as const, observedAt: 1_000 },
      },
    },
  };
  expect(outbox.enqueue(terminal)).toMatchObject({
    ok: true,
    value: { localSequence: 3, predecessorEventId: "event_2", priority: "CRITICAL" },
  });
  expect(outbox.markInFlight("event_1")).toMatchObject({ ok: true });
  database.close();

  database = openRunnerDatabase(path);
  outbox = createRunnerSemanticOutbox(database, () => 1_001, {
    maximumItems: 3,
    maximumBytes: 65_536,
    reservedCriticalItems: 1,
    reservedCriticalBytes: 8_192,
  });
  expect(outbox.requeueInFlight()).toEqual({ ok: true, value: { requeued: 1 } });
  expect(outbox.ready().map((entry) => [entry.eventId, entry.localSequence])).toEqual([
    ["event_1", 1],
    ["event_2", 2],
    ["event_terminal", 3],
  ]);
  expect(outbox.acknowledge("event_1", "APPLIED")).toMatchObject({
    ok: true,
    value: { state: "ACKNOWLEDGED" },
  });
  expect(outbox.acknowledge("event_2", "REJECTED", "LIFECYCLE_REVISION_STALE")).toMatchObject({
    ok: true,
    value: { state: "PERMANENTLY_REJECTED" },
  });
  expect(outbox.inspect("event_1")).toMatchObject({ ok: true, value: { localSequence: 1 } });
  database.close();
});

test("semantic outbox maintains an independent causal chain for each run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-continuity-chains-"));
  directories.push(directory);
  const database = openRunnerDatabase(join(directory, "runner.db"));
  const outbox = createRunnerSemanticOutbox(database, () => 1_000);
  const event = (eventId: string, runId: string) => ({
    eventId,
    runId,
    body: {
      kind: "EVIDENCE" as const,
      eventId,
      payload: {
        runId,
        expectedRunRevision: 1,
        attemptId: `${runId}_attempt`,
        evidence: {
          kind: "VERIFICATION" as const,
          name: "check",
          outcome: "PASSED" as const,
          durationMs: 1,
          summary: "Verification passed.",
        },
      },
    },
  });
  expect(outbox.enqueue(event("event_a1", "run_a"))).toMatchObject({
    ok: true,
    value: { localSequence: 1 },
  });
  expect(outbox.enqueue(event("event_b1", "run_b"))).toMatchObject({
    ok: true,
    value: { localSequence: 1 },
  });
  expect(outbox.enqueue(event("event_a2", "run_a"))).toMatchObject({
    ok: true,
    value: { localSequence: 2, predecessorEventId: "event_a1" },
  });
  database.close();
});

test("server semantic acceptance commits effect, audit, dedup, and ACK intent exactly once", () => {
  const database = new Database(":memory:", { strict: true });
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE runners(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE agent_runs(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE execution_attempts(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE accepted_runner_events(
      runner_id TEXT NOT NULL, semantic_event_id TEXT NOT NULL, run_id TEXT NOT NULL,
      attempt_id TEXT, schema_version INTEGER NOT NULL, event_kind TEXT NOT NULL,
      local_sequence INTEGER NOT NULL, predecessor_event_id TEXT, input_hash TEXT NOT NULL,
      committed_result_id TEXT NOT NULL, disposition TEXT NOT NULL, accepted_at INTEGER NOT NULL,
      PRIMARY KEY(runner_id, semantic_event_id), UNIQUE(runner_id, run_id, local_sequence)
    ) STRICT;
    CREATE TABLE accepted_event_ack_outbox(
      id TEXT PRIMARY KEY, runner_id TEXT NOT NULL, semantic_event_id TEXT NOT NULL,
      result_reference TEXT NOT NULL, semantic_digest TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL, retry_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
      dispatched_at INTEGER, acknowledged_at INTEGER
    ) STRICT;
    CREATE TABLE audit_events(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor_kind TEXT NOT NULL,
      actor_id TEXT NOT NULL, subject_id TEXT, safe_details TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE effects(id TEXT PRIMARY KEY) STRICT;
  `);
  let nextId = 0;
  const dedup = createRunnerEventDeduplicator({
    database,
    clock: () => 1_000,
    id: (kind) => `${kind}_${++nextId}`,
  });
  const input = {
    runnerId: "runner_1",
    eventId: "event_1",
    runId: "run_1",
    attemptId: "attempt_1",
    eventKind: "EVIDENCE" as const,
    localSequence: 1,
    inputHash: "a".repeat(64),
  };
  const first = dedup.accept(input, () => {
    database.query("INSERT INTO effects(id) VALUES ('effect_1')").run();
    return { ok: true, value: { resultReference: "evidence_1", disposition: "APPLIED" as const } };
  });
  expect(first).toMatchObject({ ok: true, value: { disposition: "APPLIED" } });
  expect(
    dedup.accept(input, () => {
      throw new Error("duplicate effect executed");
    }),
  ).toMatchObject({ ok: true, value: { disposition: "DUPLICATE" } });
  expect(dedup.accept({ ...input, inputHash: "b".repeat(64) }, () => first as never)).toMatchObject(
    {
      ok: false,
      error: { code: "RUNNER_EVENT_ID_CONFLICT" },
    },
  );
  expect(
    dedup.accept({ ...input, eventId: "event_3", localSequence: 3 }, () => first as never),
  ).toMatchObject({ ok: false, error: { code: "RUNNER_EVENT_OUT_OF_ORDER" } });
  expect(
    database.query<{ count: number }, []>("SELECT count(*) AS count FROM effects").get()?.count,
  ).toBe(1);
  expect(
    database
      .query<{ count: number }, []>("SELECT count(*) AS count FROM accepted_runner_events")
      .get()?.count,
  ).toBe(1);
  expect(
    database
      .query<{ count: number }, []>("SELECT count(*) AS count FROM accepted_event_ack_outbox")
      .get()?.count,
  ).toBe(1);
  expect(
    database.query<{ count: number }, []>("SELECT count(*) AS count FROM audit_events").get()
      ?.count,
  ).toBe(1);
  database.close();
});
