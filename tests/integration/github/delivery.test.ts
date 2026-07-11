import { expect, test } from "bun:test";
import type { GitHubProjection } from "../../../src/shared/contracts/github.ts";
import {
  closingReference,
  observeDelivery,
} from "../../../src/server/modules/github-coordination/delivery.ts";

function observed(value: GitHubProjection) {
  return {
    value,
    reference: "ref",
    sourceRevision: "v1",
    comparableDigest: "a".repeat(64) as never,
    projectionRevision: 1,
    observedAt: 1,
    freshness: "FRESH" as const,
    provenance: {
      projectId: "project_1" as never,
      connectorId: "github_1" as never,
      connectorEpoch: 1,
      kind: "RECONCILIATION" as const,
    },
  };
}

test("closing references use fresh repository metadata while identity remains immutable", () => {
  const result = closingReference({
    issue: { kind: "ISSUE", repositoryId: "101", number: 42 },
    repository: observed({
      kind: "REPOSITORY",
      repositoryId: "101",
      repositoryNodeId: "R_101",
      ownerLogin: "renamed-owner",
      name: "renamed-repo",
      permissionDigest: "b".repeat(64),
    }),
  });
  expect(result).toEqual({ ok: true, value: "Closes renamed-owner/renamed-repo#42" });
});

test("merged pull request never fabricates issue closure", () => {
  const pullRequest = observed({
    kind: "PULL_REQUEST",
    repositoryId: "101",
    number: 7,
    title: "PR",
    state: "CLOSED",
    draft: false,
    merged: true,
    headSha: "a".repeat(40),
    baseRef: "main",
    labels: [],
    assignees: [],
  });
  const open = observeDelivery({
    pullRequest,
    issue: observed({
      kind: "ISSUE",
      repositoryId: "101",
      number: 42,
      title: "Issue",
      state: "OPEN",
      labels: [],
      assignees: [],
    }),
  });
  expect(open).toEqual({ pullRequestMerged: true, issueState: "OPEN", delivered: false });
  const closed = observeDelivery({
    pullRequest,
    issue: observed({
      kind: "ISSUE",
      repositoryId: "101",
      number: 42,
      title: "Issue",
      state: "CLOSED",
      labels: [],
      assignees: [],
    }),
  });
  expect(closed.delivered).toBe(true);
});
