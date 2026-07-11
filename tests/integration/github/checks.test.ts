import { expect, test } from "bun:test";
import { evaluateCheck } from "../../../src/server/modules/evidence/github-checks.ts";

test("GitHub checks bind exact repository, scope, check name, and published SHA", () => {
  const observation = {
    checkRunId: "1",
    repositoryId: "101",
    commitSha: "a".repeat(40),
    checkName: "ci",
    status: "COMPLETED" as const,
    conclusion: "SUCCESS" as const,
    scopeDigest: "b".repeat(64),
    observedAt: 1,
    fresh: true,
  };
  const published = {
    repositoryId: "101",
    remoteIdentity: "origin",
    commitSha: "a".repeat(40),
    scopeDigest: "b".repeat(64),
    requiredCheckName: "ci",
  };
  expect(evaluateCheck(observation, published).ok).toBe(true);
  expect(evaluateCheck(observation, { ...published, commitSha: "c".repeat(40) })).toMatchObject({
    ok: false,
    error: { code: "GATE_EVALUATION_STALE" },
  });
});
