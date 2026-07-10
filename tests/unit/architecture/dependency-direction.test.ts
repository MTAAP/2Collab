import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ResultSchema } from "../../../src/shared/contracts/result.ts";

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

  test("rejects domain imports of adapters", async () => {
    for (const name of await readdir("src/domain", { recursive: true })) {
      if (!name.endsWith(".ts")) continue;
      const source = await readFile(join("src/domain", name), "utf8");
      expect(source).not.toMatch(/from ["'](?:.*\/)?(?:server\/adapters|runner\/adapters|web|cli)/);
    }
  });
});
