import { expect, test } from "bun:test";
import { evaluateMutationGuard } from "../../../src/server/modules/coordination-records/mutation-guard.ts";

test("mutation guard, override, and exact branch collision remain distinct", () => {
  expect(
    evaluateMutationGuard({
      coordinationRecordId: "record_1",
      runId: "run_b",
      heldByRunId: "run_a",
      repositoryId: "repo",
      intendedBranch: "collab/b",
      activeBranches: [],
    }),
  ).toMatchObject({ ok: false, error: { code: "MUTATION_GUARD_HELD" } });
  expect(
    evaluateMutationGuard({
      coordinationRecordId: "record_1",
      runId: "run_b",
      heldByRunId: "run_a",
      overrideAuditId: "audit_1",
      repositoryId: "repo",
      intendedBranch: "collab/b",
      activeBranches: [],
    }),
  ).toEqual({ ok: true, value: { overridden: true } });
  expect(
    evaluateMutationGuard({
      coordinationRecordId: "record_2",
      runId: "run_b",
      repositoryId: "repo",
      intendedBranch: "collab/a",
      activeBranches: [{ runId: "run_a", repositoryId: "repo", intendedBranch: "collab/a" }],
    }),
  ).toMatchObject({ ok: false, error: { code: "BRANCH_COLLISION" } });
});
