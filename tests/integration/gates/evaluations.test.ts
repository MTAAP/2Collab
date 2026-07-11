import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import migration15 from "../../../src/server/db/migrations/0015_gates_telemetry.sql" with {
  type: "text",
};
import { approveGateFingerprint } from "../../../src/server/modules/gates/fingerprints.ts";
import {
  createGateCoordinator,
  createGateEvaluationStore,
} from "../../../src/server/modules/gates/evaluations.ts";

let database: Database;
beforeEach(() => {
  database = new Database(":memory:", { strict: true });
  database.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;",
  );
  for (let version = 1; version <= 14; version += 1)
    database.query("INSERT INTO schema_migrations VALUES (?,0)").run(version);
  database.exec(migration15);
});
afterEach(() => database.close());

test("persists owner approval and exact-SHA GitHub evidence idempotently", async () => {
  const fingerprint = "f".repeat(64);
  const revision = "a".repeat(40);
  expect(
    approveGateFingerprint(database, {
      projectId: "project_1",
      baseRevision: revision,
      fingerprint,
      approvedByRunnerOwnerId: "owner_1",
      approvedAt: 100,
    }),
  ).toMatchObject({ ok: true });
  const gates = createGateEvaluationStore({ database, clock: () => 100 });
  const command = {
    id: "evaluation_1",
    projectId: "project_1",
    baseRevision: revision,
    runId: "run_1",
    repositoryRevision: revision,
    gateKey: "checks",
    manifestFingerprint: fingerprint,
    kind: "GITHUB_CHECK" as const,
  };
  expect(
    await gates.recordGitHub(
      command,
      {
        checkRunId: "42",
        repositoryId: "7",
        commitSha: revision,
        checkName: "verify",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        scopeDigest: "d".repeat(64),
        observedAt: 100,
        fresh: true,
      },
      {
        repositoryId: "7",
        scopeDigest: "d".repeat(64),
        checkName: "verify",
        acceptableConclusions: ["SUCCESS"],
      },
    ),
  ).toMatchObject({ ok: true, value: { state: "PASSED" } });
  expect(
    await gates.recordGitHub(
      command,
      {
        checkRunId: "42",
        repositoryId: "7",
        commitSha: revision,
        checkName: "verify",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        scopeDigest: "d".repeat(64),
        observedAt: 100,
        fresh: true,
      },
      {
        repositoryId: "7",
        scopeDigest: "d".repeat(64),
        checkName: "verify",
        acceptableConclusions: ["SUCCESS"],
      },
    ),
  ).toMatchObject({ ok: true, value: { id: "evaluation_1" } });
  expect(
    database.query<{ count: number }, []>("SELECT count(*) AS count FROM gate_evaluations").get()
      ?.count,
  ).toBe(1);
});

test("wrong SHA and replay under another binding fail closed", async () => {
  const fingerprint = "f".repeat(64);
  const revision = "a".repeat(40);
  approveGateFingerprint(database, {
    projectId: "project_1",
    baseRevision: revision,
    fingerprint,
    approvedByRunnerOwnerId: "owner_1",
    approvedAt: 100,
  });
  const gates = createGateEvaluationStore({ database, clock: () => 100 });
  const command = {
    id: "evaluation_1",
    projectId: "project_1",
    baseRevision: revision,
    runId: "run_1",
    repositoryRevision: revision,
    gateKey: "checks",
    manifestFingerprint: fingerprint,
    kind: "GITHUB_CHECK" as const,
  };
  expect(
    await gates.recordGitHub(
      command,
      {
        checkRunId: "42",
        repositoryId: "7",
        commitSha: "b".repeat(40),
        checkName: "verify",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        scopeDigest: "d".repeat(64),
        observedAt: 100,
        fresh: true,
      },
      {
        repositoryId: "7",
        scopeDigest: "d".repeat(64),
        checkName: "verify",
        acceptableConclusions: ["SUCCESS"],
      },
    ),
  ).toMatchObject({ ok: false, error: { code: "GATE_REVISION_STALE" } });
  await gates.recordGitHub(
    command,
    {
      checkRunId: "42",
      repositoryId: "7",
      commitSha: revision,
      checkName: "verify",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      scopeDigest: "d".repeat(64),
      observedAt: 100,
      fresh: true,
    },
    {
      repositoryId: "7",
      scopeDigest: "d".repeat(64),
      checkName: "verify",
      acceptableConclusions: ["SUCCESS"],
    },
  );
  expect(
    await gates.recordGitHub(
      { ...command, runId: "run_2" },
      {
        checkRunId: "42",
        repositoryId: "7",
        commitSha: revision,
        checkName: "verify",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        scopeDigest: "d".repeat(64),
        observedAt: 100,
        fresh: true,
      },
      {
        repositoryId: "7",
        scopeDigest: "d".repeat(64),
        checkName: "verify",
        acceptableConclusions: ["SUCCESS"],
      },
    ),
  ).toMatchObject({ ok: false, error: { code: "GATE_EVALUATION_REPLAY" } });
});

test("persists bounded local evidence and fails tracked mutation", async () => {
  const fingerprint = "f".repeat(64);
  const baseRevision = "a".repeat(40);
  approveGateFingerprint(database, {
    projectId: "project_1",
    baseRevision,
    fingerprint,
    approvedByRunnerOwnerId: "owner_1",
    approvedAt: 100,
  });
  const gates = createGateEvaluationStore({ database, clock: () => 150 });
  const command = {
    id: "evaluation_local",
    projectId: "project_1",
    baseRevision,
    runId: "run_1",
    repositoryRevision: "b".repeat(40),
    gateKey: "unit",
    manifestFingerprint: fingerprint,
    kind: "LOCAL_COMMAND" as const,
  };
  expect(await gates.startLocal(command)).toMatchObject({
    ok: true,
    value: { state: "PENDING" },
  });
  expect(
    await gates.recordLocal(command, {
      exitCode: 0,
      durationMs: 42,
      timedOut: false,
      cancelled: false,
      trackedMutation: true,
      outputDigest: "e".repeat(64),
    }),
  ).toMatchObject({ ok: true, value: { state: "FAILED" } });
});

test("rejects evaluation under an unapproved fingerprint", async () => {
  const gates = createGateEvaluationStore({ database, clock: () => 100 });
  expect(
    await gates.recordLocal(
      {
        id: "evaluation_local",
        projectId: "project_1",
        baseRevision: "a".repeat(40),
        runId: "run_1",
        repositoryRevision: "b".repeat(40),
        gateKey: "unit",
        manifestFingerprint: "f".repeat(64),
        kind: "LOCAL_COMMAND",
      },
      {
        exitCode: 0,
        durationMs: 42,
        timedOut: false,
        cancelled: false,
        trackedMutation: false,
        outputDigest: "e".repeat(64),
      },
    ),
  ).toMatchObject({ ok: false, error: { code: "GATE_FINGERPRINT_STALE" } });
});

test("coordinator rejects a manifest from the run worktree", async () => {
  const gates = createGateCoordinator({ database, clock: () => 100 });
  expect(
    await gates.evaluate({
      id: "evaluation_untrusted",
      projectId: "project_1",
      baseRevision: "a".repeat(40),
      runId: "run_1",
      repositoryRevision: "b".repeat(40),
      gateKey: "unit",
      manifestFingerprint: "f".repeat(64),
      kind: "LOCAL_COMMAND",
      manifestSource: "RUN_WORKTREE",
    }),
  ).toMatchObject({ ok: false, error: { code: "GATE_MANIFEST_UNTRUSTED" } });
});
