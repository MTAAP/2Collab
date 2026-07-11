import { describe, expect, test } from "bun:test";
import { deriveConsecutiveDayStreak } from "../../../scripts/evidence/foundation-contract.ts";

describe("Foundation dogfood streak", () => {
  test("uses calendar dates across DST and resets on repairs or missing dates", () => {
    const valid = ["2026-10-23", "2026-10-24", "2026-10-25"].map((localDate, index) => ({
      localDate,
      buildId: "build_0123456789abcdef",
      completed: true as const,
      reviewed: true as const,
      directDatabaseRepair: "NO" as const,
      backupResult: "PASS" as const,
      restoreEvidenceId: "restore_01",
      recordedAt: `2026-10-${23 + index}T12:00:00.000Z`,
    }));
    expect(deriveConsecutiveDayStreak(valid)).toBe(3);
    const last = valid[2];
    if (!last) throw new Error("fixture missing");
    expect(deriveConsecutiveDayStreak([...valid, { ...last, localDate: "2026-10-27" }])).toBe(1);
    expect(
      deriveConsecutiveDayStreak([
        ...valid,
        { ...last, localDate: "2026-10-26", directDatabaseRepair: "YES" },
      ]),
    ).toBe(0);
  });
});
