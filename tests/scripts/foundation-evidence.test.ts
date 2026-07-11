import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FoundationEvidenceService } from "../../scripts/foundation-evidence.ts";

describe("foundation-evidence operator service", () => {
  test("initialized evidence validates while the external exit remains unmet", async () => {
    const directory = await mkdtemp(join(tmpdir(), "foundation-evidence-"));
    try {
      const service = new FoundationEvidenceService(
        join(directory, "evidence.json"),
        () => new Date("2026-07-11T12:00:00Z"),
      );
      await service.init({
        buildId: "build_0123456789abcdef",
        artifactManifestSha256: "a".repeat(64),
        repositoryCommit: "b".repeat(40),
        timezone: "Europe/Berlin",
      });
      expect(await service.validate()).toEqual({ status: "IN_PROGRESS_EXTERNAL" });
      expect(await service.checkExit()).toMatchObject({
        ok: false,
        code: "FOUNDATION_EXIT_NOT_MET",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("appends an explicit same-day correction without mutating the original", async () => {
    const directory = await mkdtemp(join(tmpdir(), "foundation-evidence-correction-"));
    try {
      const path = join(directory, "evidence.json");
      const service = new FoundationEvidenceService(path, () => new Date("2026-07-11T12:00:00Z"));
      await service.init({
        buildId: "build_0123456789abcdef",
        artifactManifestSha256: "a".repeat(64),
        repositoryCommit: "b".repeat(40),
        timezone: "Europe/Berlin",
      });
      await service.closeDay({
        evidenceId: "day_original",
        buildId: "build_0123456789abcdef",
        completed: false,
        reviewed: false,
        directDatabaseRepair: "NO",
        runIds: [],
        incidents: "NONE",
        migrationsOrRestarts: "NONE",
        backupResult: "NOT_RUN",
        restoreEvidenceId: "restore_pending",
      });
      await service.correctDay({
        evidenceId: "day_correction",
        correctionOf: "day_original",
        buildId: "build_0123456789abcdef",
        completed: false,
        reviewed: false,
        directDatabaseRepair: "NO",
        runIds: [],
        incidents: "NONE",
        migrationsOrRestarts: "NONE",
        backupResult: "NOT_RUN",
        restoreEvidenceId: "restore_pending",
      });
      const stored = await Bun.file(path).json();
      expect(stored.days).toHaveLength(2);
      expect(stored.days[0]).not.toHaveProperty("correctionOf");
      expect(stored.days[1]).toMatchObject({
        localDate: stored.days[0].localDate,
        correctionOf: "day_original",
      });
      await expect(
        service.correctDay({ ...stored.days[1], evidenceId: "day_branch" }),
      ).rejects.toThrow("EVIDENCE_CORRECTION_BRANCH_INVALID");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
