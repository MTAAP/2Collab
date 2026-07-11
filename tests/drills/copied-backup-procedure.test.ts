import { describe, expect, test } from "bun:test";
import { planFoundationRestore } from "../../scripts/foundation-restore-drill.ts";

describe("copied backup restore procedure", () => {
  test("refuses production or existing volumes and defaults to dry-run without listeners", async () => {
    expect(planFoundationRestore({ project: "2collab", dataVolumeExists: false })).toMatchObject({
      ok: false,
      code: "RESTORE_TARGET_UNSAFE",
    });
    expect(
      planFoundationRestore({ project: "foundation-restore-01234567", dataVolumeExists: true }),
    ).toMatchObject({ ok: false, code: "RESTORE_TARGET_UNSAFE" });
    expect(
      planFoundationRestore({ project: "foundation-restore-01234567", dataVolumeExists: false }),
    ).toMatchObject({ ok: true, mode: "DRY_RUN", listeners: "DISABLED" });
  });
});
