import { describe, expect, test } from "bun:test";
import {
  checkFoundationExit,
  createEmptyFoundationEvidence,
  FoundationEvidenceSchema,
  MachineRunEvidenceSchema,
  validateEvidence,
} from "../../../scripts/evidence/foundation-contract.ts";

describe("Foundation live evidence schema", () => {
  test("accepts an honest pending record but does not claim the exit", () => {
    const evidence = createEmptyFoundationEvidence({
      buildId: "build_0123456789abcdef",
      artifactManifestSha256: "a".repeat(64),
      repositoryCommit: "b".repeat(40),
      timezone: "Europe/Berlin",
    });
    expect(FoundationEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(validateEvidence(evidence)).toEqual({ status: "IN_PROGRESS_EXTERNAL" });
  });

  test("rejects manually supplied aggregate status fields", () => {
    const evidence = {
      ...createEmptyFoundationEvidence({
        buildId: "build_0123456789abcdef",
        artifactManifestSha256: "a".repeat(64),
        repositoryCommit: "b".repeat(40),
        timezone: "UTC",
      }),
      status: "PASS",
    };
    expect(FoundationEvidenceSchema.safeParse(evidence).success).toBe(false);
  });

  test("does not count machine enrollments without authenticated review", () => {
    const evidence = createEmptyFoundationEvidence({
      buildId: "build_0123456789abcdef",
      artifactManifestSha256: "a".repeat(64),
      repositoryCommit: "b".repeat(40),
      timezone: "UTC",
    });
    evidence.machines.push(
      {
        evidenceId: "machine_evidence_1",
        ownerId: "owner_1",
        machineId: "machine_1",
        runnerId: "runner_1",
        generation: 1,
        enrolledAt: "2026-07-11T12:00:00.000Z",
      },
      {
        evidenceId: "machine_evidence_2",
        ownerId: "owner_2",
        machineId: "machine_2",
        runnerId: "runner_2",
        generation: 1,
        enrolledAt: "2026-07-11T12:00:00.000Z",
      },
    );
    expect(checkFoundationExit(evidence)).toMatchObject({
      ok: false,
      missing: expect.arrayContaining(["TWO_REVIEWED_OWNERS_AND_MACHINES"]),
    });
  });

  test("requires reviewer provenance when a day claims reviewed", () => {
    const evidence = createEmptyFoundationEvidence({
      buildId: "build_0123456789abcdef",
      artifactManifestSha256: "a".repeat(64),
      repositoryCommit: "b".repeat(40),
      timezone: "UTC",
    });
    expect(
      FoundationEvidenceSchema.safeParse({
        ...evidence,
        days: [
          {
            evidenceId: "day_1",
            localDate: "2026-07-11",
            buildId: evidence.frozenBuild.buildId,
            completed: true,
            reviewed: true,
            directDatabaseRepair: "NO",
            runIds: [],
            incidents: "NONE",
            migrationsOrRestarts: "NONE",
            backupResult: "PASS",
            restoreEvidenceId: "restore_1",
            recordedAt: "2026-07-11T12:00:00.000Z",
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects an accepted day whose restore reference is missing or unreviewed", () => {
    const evidence = createEmptyFoundationEvidence({
      buildId: "build_0123456789abcdef",
      artifactManifestSha256: "a".repeat(64),
      repositoryCommit: "b".repeat(40),
      timezone: "UTC",
    });
    evidence.days.push({
      evidenceId: "day_1",
      localDate: "2026-07-11",
      buildId: evidence.frozenBuild.buildId,
      completed: true,
      reviewed: true,
      directDatabaseRepair: "NO",
      runIds: [],
      incidents: "NONE",
      migrationsOrRestarts: "NONE",
      backupResult: "PASS",
      restoreEvidenceId: "restore_missing",
      recordedAt: "2026-07-11T12:00:00.000Z",
      reviewer: { memberId: "owner_1", reviewedAt: "2026-07-11T12:01:00.000Z" },
    });
    expect(() => validateEvidence(evidence)).toThrow("DOGFOOD_RESTORE_EVIDENCE_INVALID");
  });

  test("uses canonical attempt lifecycle and run-result vocabularies", () => {
    const row = {
      schemaVersion: 1,
      evidenceId: "evidence_run_1",
      buildId: "build_0123456789abcdef",
      artifactManifestSha256: "a".repeat(64),
      ownerId: "owner_1",
      machineId: "machine_1",
      machineGeneration: 1,
      runnerId: "runner_1",
      runId: "run_1",
      attemptId: "attempt_1",
      runnerEpoch: 1,
      policyRevision: 1,
      mappingRevision: 1,
      profileRevision: 1,
      profileFingerprint: "b".repeat(64),
      runtime: "CODEX",
      host: "NATIVE",
      mode: "HEADLESS",
      launchSurface: "CLI",
      startedAt: "2026-07-11T12:00:00.000Z",
      terminalAt: "2026-07-11T12:01:00.000Z",
      attemptLifecycle: "EXITED",
      runResult: "DELIVERED",
      hostAdapterProvenance: "NATIVE_ADAPTER",
      interactiveLocalPresence: "NOT_APPLICABLE",
      sharedTransportPrivacy: "PASS",
      result: "PASS",
    };
    expect(MachineRunEvidenceSchema.safeParse(row).success).toBe(true);
    expect(
      MachineRunEvidenceSchema.safeParse({
        ...row,
        attemptLifecycle: "SUCCEEDED",
        runResult: "SUCCEEDED",
      }).success,
    ).toBe(false);
  });
});
