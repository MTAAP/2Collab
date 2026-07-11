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
    `PRAGMA foreign_keys=ON;
     CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
     CREATE TABLE runners(
       id TEXT PRIMARY KEY, owner_member_id TEXT NOT NULL, runner_epoch INTEGER NOT NULL,
       revoked_at INTEGER
     ) STRICT;
     CREATE TABLE execution_attempts(
       id TEXT PRIMARY KEY, run_id TEXT NOT NULL, runner_id TEXT NOT NULL REFERENCES runners(id)
     ) STRICT;
     CREATE TABLE authority_sessions(
       id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES execution_attempts(id),
       runner_id TEXT NOT NULL REFERENCES runners(id), runner_epoch INTEGER NOT NULL,
       fence INTEGER NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL
     ) STRICT;
     INSERT INTO runners VALUES ('runner_1', 'owner_1', 1, NULL);`,
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

test("a GitHub check advances only from pending to one terminal observation", async () => {
  const fingerprint = "f".repeat(64);
  const revision = "a".repeat(40);
  approveGateFingerprint(database, {
    projectId: "project_1",
    baseRevision: revision,
    fingerprint,
    approvedByRunnerOwnerId: "owner_1",
    approvedAt: 100,
  });
  let now = 100;
  const gates = createGateEvaluationStore({ database, clock: () => now });
  const command = {
    id: "evaluation_pending",
    projectId: "project_1",
    baseRevision: revision,
    runId: "run_1",
    repositoryRevision: revision,
    gateKey: "checks",
    manifestFingerprint: fingerprint,
    kind: "GITHUB_CHECK" as const,
  };
  const required = {
    repositoryId: "7",
    scopeDigest: "d".repeat(64),
    checkName: "verify",
    acceptableConclusions: ["SUCCESS" as const],
  };
  const pending = {
    checkRunId: "42",
    repositoryId: "7",
    commitSha: revision,
    checkName: "verify",
    status: "IN_PROGRESS" as const,
    conclusion: null,
    scopeDigest: "d".repeat(64),
    observedAt: 100,
    fresh: true,
  };
  expect(await gates.recordGitHub(command, pending, required)).toMatchObject({
    ok: true,
    value: { state: "PENDING" },
  });
  now = 200;
  expect(
    await gates.recordGitHub(
      command,
      { ...pending, status: "COMPLETED", conclusion: "SUCCESS", observedAt: 200 },
      required,
    ),
  ).toMatchObject({ ok: true, value: { state: "PASSED", createdAt: 100, completedAt: 200 } });
  expect(
    await gates.recordGitHub(
      command,
      { ...pending, status: "COMPLETED", conclusion: "FAILURE", observedAt: 300 },
      required,
    ),
  ).toMatchObject({ ok: false, error: { code: "GATE_EVALUATION_REPLAY" } });
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

test("coordinator accepts fingerprint approval only from the real active runner owner", async () => {
  const gates = createGateCoordinator({ database, clock: () => 100 });
  const command = {
    runnerId: "runner_1",
    projectId: "project_1",
    baseRevision: "a".repeat(40),
    fingerprint: "f".repeat(64),
    approvedAt: 100,
  };
  expect(
    await gates.approveFingerprint({ ...command, approvedByRunnerOwnerId: "member_2" }),
  ).toMatchObject({ ok: false, error: { code: "RUNNER_OWNER_REQUIRED" } });
  expect(
    await gates.approveFingerprint({ ...command, approvedByRunnerOwnerId: "owner_1" }),
  ).toMatchObject({ ok: true, value: { fingerprint: "f".repeat(64) } });
});

test("coordinator accepts local PASS only from the exact live runner session fence", async () => {
  const fingerprint = "f".repeat(64);
  const baseRevision = "a".repeat(40);
  approveGateFingerprint(database, {
    projectId: "project_1",
    baseRevision,
    fingerprint,
    approvedByRunnerOwnerId: "owner_1",
    approvedAt: 100,
  });
  database.query("INSERT INTO execution_attempts VALUES ('attempt_1', 'run_1', 'runner_1')").run();
  database
    .query(
      "INSERT INTO authority_sessions VALUES ('session_1', 'attempt_1', 'runner_1', 1, 2, 'ACTIVE', 1000)",
    )
    .run();
  const gates = createGateCoordinator({ database, clock: () => 100 });
  const command = {
    id: "evaluation_secure",
    projectId: "project_1",
    baseRevision,
    runId: "run_1",
    repositoryRevision: "b".repeat(40),
    gateKey: "unit",
    manifestFingerprint: fingerprint,
    kind: "LOCAL_COMMAND" as const,
    manifestSource: "TRUSTED_BASE" as const,
    runnerActor: { kind: "RUNNER" as const, runnerId: "runner_1" as never, runnerEpoch: 1 },
    sessionId: "session_1",
    sessionFence: 2,
    idempotencyKey: "gate_secure",
    localEvidence: {
      exitCode: 0,
      durationMs: 10,
      timedOut: false,
      cancelled: false,
      trackedMutation: false,
      outputDigest: "e".repeat(64),
    },
  };
  expect(await gates.evaluate({ ...command, sessionFence: 3 })).toMatchObject({
    ok: false,
    error: { code: "GATE_RUNNER_EVIDENCE_STALE" },
  });
  expect(await gates.evaluate(command)).toMatchObject({
    ok: true,
    value: { state: "PASSED" },
  });
});
