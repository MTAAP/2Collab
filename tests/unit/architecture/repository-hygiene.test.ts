import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("repository hygiene", () => {
  test("runtime artifact ignores are root-scoped and cannot hide source modules", async () => {
    const lines = (await readFile(".gitignore", "utf8"))
      .split("\n")
      .filter((line) => line.length > 0);
    for (const directory of [
      ".worktrees",
      ".superpowers",
      "dist",
      "playwright-report",
      "test-results",
      "data",
      "runner-state",
      "transcripts",
      "credentials",
    ]) {
      expect(lines).toContain(`/${directory}/`);
      expect(lines).not.toContain(`${directory}/`);
    }
  });
});
