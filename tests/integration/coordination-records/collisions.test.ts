import { expect, test } from "bun:test";
import { changedPathCollision } from "../../../src/server/modules/coordination-records/collisions.ts";

test("cross-record changed path overlap is advisory and path-free", () => {
  const result = changedPathCollision(
    { runId: "run_a", paths: ["src/a.ts", "src/b.ts"] },
    { runId: "run_b", paths: ["src/a.ts"] },
    10,
  );
  expect(result).toEqual({
    runA: "run_a",
    runB: "run_b",
    blocking: false,
    overlapCount: 1,
    observedAt: 10,
  });
  expect(JSON.stringify(result)).not.toContain("src/a.ts");
});
