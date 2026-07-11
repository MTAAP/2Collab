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
});
