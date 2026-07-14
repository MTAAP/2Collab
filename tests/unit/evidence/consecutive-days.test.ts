import { describe, expect, test } from "bun:test";
import {
  deriveConsecutiveDayStreak,
  resolveEffectiveDogfoodDays,
} from "../../../scripts/evidence/foundation-contract.ts";

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

  test("accepts an append-only same-day correction and supersedes only its referenced row", () => {
    const reviewer = { memberId: "owner_1", reviewedAt: "2026-07-11T12:00:00.000Z" };
    const original = {
      evidenceId: "day_original",
      localDate: "2026-07-11",
      buildId: "build_0123456789abcdef",
      completed: false,
      reviewed: false,
      directDatabaseRepair: "NO" as const,
      runIds: [],
      incidents: "NONE" as const,
      migrationsOrRestarts: "NONE" as const,
      backupResult: "NOT_RUN" as const,
      restoreEvidenceId: "restore_1",
      recordedAt: "2026-07-11T10:00:00.000Z",
    };
    const correction = {
      ...original,
      evidenceId: "day_correction",
      completed: true,
      reviewed: true,
      backupResult: "PASS" as const,
      recordedAt: "2026-07-11T12:00:00.000Z",
      reviewer,
      correctionOf: original.evidenceId,
    };
    expect(resolveEffectiveDogfoodDays([original, correction])).toEqual([correction]);
  });

  test("rejects duplicate, branching, cross-date, or unknown correction references", () => {
    const original = {
      evidenceId: "day_original",
      localDate: "2026-07-11",
      buildId: "build_0123456789abcdef",
      completed: false,
      reviewed: false,
      directDatabaseRepair: "NO" as const,
      runIds: [],
      incidents: "NONE" as const,
      migrationsOrRestarts: "NONE" as const,
      backupResult: "NOT_RUN" as const,
      restoreEvidenceId: "restore_1",
      recordedAt: "2026-07-11T10:00:00.000Z",
    };
    expect(() =>
      resolveEffectiveDogfoodDays([original, { ...original, evidenceId: "duplicate" }]),
    ).toThrow();
    expect(() =>
      resolveEffectiveDogfoodDays([
        original,
        { ...original, evidenceId: "correction_1", correctionOf: original.evidenceId },
        { ...original, evidenceId: "correction_2", correctionOf: original.evidenceId },
      ]),
    ).toThrow();
    expect(() =>
      resolveEffectiveDogfoodDays([
        original,
        {
          ...original,
          evidenceId: "cross_date",
          localDate: "2026-07-12",
          correctionOf: original.evidenceId,
        },
      ]),
    ).toThrow();
    expect(() =>
      resolveEffectiveDogfoodDays([{ ...original, correctionOf: "unknown_day" }]),
    ).toThrow();
  });
});
