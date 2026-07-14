import { expect, test } from "bun:test";
import { performGitHubMutation } from "../../../src/server/modules/github-coordination/mutations.ts";
import { actor, command, fixture, observedIssue } from "./mutation-fixture.ts";

test("a lost response remains ambiguous while provider state is recoverable by exact inspection", async () => {
  const f = fixture();
  const current = await observedIssue(f.github);
  f.github.failNext("ADD_COMMENT", "LOST_RESPONSE");
  const result = await performGitHubMutation({
    github: f.github,
    connectorAuthority: f.authority,
    authorized: {
      authorityKind: "MEMBER",
      actor,
      command: command(
        {
          kind: "ADD_COMMENT",
          issue: { kind: "ISSUE", repositoryId: "101", number: 1 },
          body: "Confirmed at provider",
        },
        {
          kind: "EXACT_REVISION",
          sourceRevision: current.sourceRevision,
          comparableDigest: current.comparableDigest,
        },
      ),
    },
  });
  expect(result).toMatchObject({
    ok: false,
    error: { code: "GITHUB_RESULT_AMBIGUOUS", retry: "REFRESH" },
  });
  expect((await observedIssue(f.github)).value).toMatchObject({ commentCount: 1 });
});
