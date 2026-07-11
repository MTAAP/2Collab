import { expect, test } from "bun:test";
import { assignAndDelegate } from "../../../src/server/modules/github-coordination/assignment-delegation.ts";

const failure = (code: string) => ({
  ok: false as const,
  error: { code, message: "failed", retry: "NEVER" as const },
});
const assignment = {
  ok: true as const,
  value: {
    value: {
      kind: "ISSUE" as const,
      repositoryId: "101",
      number: 42,
      title: "Issue",
      state: "OPEN" as const,
      labels: [],
      assignees: ["tim"],
    },
    reference: "ISSUE:101:42",
    sourceRevision: "v2",
    comparableDigest: "a".repeat(64) as never,
    projectionRevision: 2,
    observedAt: 1,
    freshness: "FRESH" as const,
    provenance: {
      projectId: "project_1" as never,
      connectorId: "github_1" as never,
      connectorEpoch: 1,
      kind: "MUTATION_CONFIRMATION" as const,
    },
  },
};

test("assignment and delegation retain independent partial success", async () => {
  const assignedOnly = await assignAndDelegate({
    assign: async () => assignment,
    delegate: async () => failure("RUNNER_OFFLINE"),
  });
  expect(assignedOnly.assignment.ok).toBe(true);
  expect(assignedOnly.delegation).toMatchObject({ ok: false, error: { code: "RUNNER_OFFLINE" } });
  const delegatedOnly = await assignAndDelegate({
    assign: async () => failure("GITHUB_FORBIDDEN"),
    delegate: async () => ({ ok: true, value: { runId: "run_1" } }),
  });
  expect(delegatedOnly.assignment).toMatchObject({
    ok: false,
    error: { code: "GITHUB_FORBIDDEN" },
  });
  expect(delegatedOnly.delegation.ok).toBe(true);
});
