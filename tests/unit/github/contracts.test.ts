import { describe, expect, test } from "bun:test";
import {
  GitHubMutationSchema,
  GitHubProjectionSchema,
  githubReferenceToSourceRef,
  sourceRefToGitHubReference,
} from "../../../src/shared/contracts/github.ts";

describe("GitHub contracts", () => {
  test("rejects provider escape hatches and unsupported destructive actions", () => {
    expect(
      GitHubMutationSchema.safeParse({ kind: "RAW_GRAPHQL", document: "mutation { x }" }).success,
    ).toBe(false);
    expect(
      GitHubMutationSchema.safeParse({ kind: "DELETE_MILESTONE", milestoneNumber: 7 }).success,
    ).toBe(false);
  });

  test("rejects no-op edits and illegal issue-state reasons", () => {
    expect(
      GitHubMutationSchema.safeParse({
        kind: "EDIT_ISSUE",
        issue: { kind: "ISSUE", repositoryId: "101", number: 1 },
      }).success,
    ).toBe(false);
    expect(
      GitHubMutationSchema.safeParse({
        kind: "SET_ISSUE_STATE",
        issue: { kind: "ISSUE", repositoryId: "101", number: 1 },
        state: "OPEN",
        reason: "COMPLETED",
      }).success,
    ).toBe(false);
  });

  test("round trips actionable references through SourceRef without mutable names", () => {
    const github = { kind: "ISSUE" as const, repositoryId: "101", number: 42 };
    const source = githubReferenceToSourceRef("github-main", github);
    expect(source.kind).toBe("GITHUB_ISSUE");
    expect(source.connectorId as string).toBe("github-main");
    expect(source.sourceItemId).toBe("101:42");
    expect(source.observedRevision).toBe("UNOBSERVED");
    expect(sourceRefToGitHubReference(source)).toEqual(github);
  });

  test("bounded projections exclude source bodies and raw payloads", () => {
    expect(
      GitHubProjectionSchema.safeParse({
        kind: "ISSUE",
        repositoryId: "101",
        number: 42,
        title: "Bounded title",
        state: "OPEN",
        labels: [],
        assignees: [],
        body: "must not persist",
      }).success,
    ).toBe(false);
  });
});
