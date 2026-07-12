import { describe, expect, test } from "bun:test";
import { performGitHubMutation } from "../../../src/server/modules/github-coordination/mutations.ts";
import { actor, command, fixture, observedIssue } from "./mutation-fixture.ts";

describe("provider-first GitHub issue mutations", () => {
  test("authorizes, confirms at provider, then projects", async () => {
    const f = fixture();
    const current = await observedIssue(f.github);
    const mutation = {
      kind: "EDIT_ISSUE" as const,
      issue: { kind: "ISSUE" as const, repositoryId: "101", number: 1 },
      title: "Updated",
    };
    const result = await performGitHubMutation({
      github: f.github,
      connectorAuthority: f.authority,
      authorized: {
        authorityKind: "MEMBER",
        actor,
        command: command(mutation, {
          kind: "EXACT_REVISION",
          sourceRevision: current.sourceRevision,
          comparableDigest: current.comparableDigest,
        }),
      },
    });
    expect(result.ok).toBe(true);
    expect(f.github.events).toEqual([
      "AUTHORIZED:EDIT_ISSUE",
      "PROVIDER_CONFIRMED:EDIT_ISSUE",
      "PROJECTED:EDIT_ISSUE",
    ]);
  });

  test("a stale reviewed revision refreshes instead of overwriting", async () => {
    const f = fixture();
    const current = await observedIssue(f.github);
    f.github.replaceIssue({ repositoryId: "101", number: 1, title: "External" });
    const mutation = {
      kind: "EDIT_ISSUE" as const,
      issue: { kind: "ISSUE" as const, repositoryId: "101", number: 1 },
      title: "Unsafe overwrite",
    };
    const result = await performGitHubMutation({
      github: f.github,
      connectorAuthority: f.authority,
      authorized: {
        authorityKind: "MEMBER",
        actor,
        command: command(mutation, {
          kind: "EXACT_REVISION",
          sourceRevision: current.sourceRevision,
          comparableDigest: current.comparableDigest,
        }),
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "SOURCE_REVISION_STALE", retry: "REFRESH" },
    });
    expect((await observedIssue(f.github)).value).toMatchObject({ title: "External" });
  });
});
