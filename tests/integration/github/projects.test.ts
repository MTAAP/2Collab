import { expect, test } from "bun:test";
import { performGitHubMutation } from "../../../src/server/modules/github-coordination/mutations.ts";
import { actor, command, fixture } from "./mutation-fixture.ts";

test("selected Project mutations reject content from unselected repositories", async () => {
  const f = fixture();
  const denied = await performGitHubMutation({
    github: f.github,
    connectorAuthority: f.authority,
    authorized: {
      authorityKind: "MEMBER",
      actor,
      command: command({
        kind: "ADD_PROJECT_ITEM",
        project: { kind: "PROJECT", projectNodeId: "PVT_1" },
        item: { kind: "ISSUE", repositoryId: "202", number: 9 },
      }),
    },
  });
  expect(denied).toMatchObject({ ok: false, error: { code: "GITHUB_REPOSITORY_NOT_SELECTED" } });
  const allowed = await performGitHubMutation({
    github: f.github,
    connectorAuthority: f.authority,
    authorized: {
      authorityKind: "MEMBER",
      actor,
      command: command({
        kind: "ADD_PROJECT_ITEM",
        project: { kind: "PROJECT", projectNodeId: "PVT_1" },
        item: { kind: "ISSUE", repositoryId: "101", number: 1 },
      }),
    },
  });
  expect(allowed).toMatchObject({
    ok: true,
    value: { value: { itemCount: 1, unsupportedRepositoryItems: 0 } },
  });
});
