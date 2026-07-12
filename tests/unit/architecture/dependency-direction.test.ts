import { describe, expect, test } from "bun:test";
import { ResultSchema } from "../../../src/shared/contracts/result.ts";
import { scanSourceImports } from "./dependency-rules.ts";

describe("shared contracts", () => {
  test("accepts bounded safe errors", () => {
    expect(
      ResultSchema.safeParse({
        ok: false,
        error: {
          code: "REVISION_CONFLICT",
          message: "Refresh required.",
          retry: "REFRESH",
          details: { currentRevision: 2 },
        },
      }).success,
    ).toBe(true);
  });

  test("enforces shared contracts to domain to modules to adapters and entrypoints", async () => {
    expect(await scanSourceImports("src")).toEqual([]);
  });
});
