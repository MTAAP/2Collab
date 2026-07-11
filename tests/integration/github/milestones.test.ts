import { expect, test } from "bun:test";
import { performGitHubMutation } from "../../../src/server/modules/github-coordination/mutations.ts";
import { actor, command, fixture } from "./mutation-fixture.ts";

test("milestone creation and edits retain provider authority", async () => {
  const f = fixture();
  const created = await performGitHubMutation({
    github: f.github,
    connectorAuthority: f.authority,
    authorized: {
      authorityKind: "MEMBER",
      actor,
      command: command({
        kind: "CREATE_MILESTONE",
        repository: { kind: "REPOSITORY", repositoryId: "101" },
        title: "V1",
        description: "",
        dueOn: null,
      }),
    },
  });
  expect(created).toMatchObject({
    ok: true,
    value: { value: { kind: "MILESTONE", title: "V1", state: "OPEN" } },
  });
  if (!created.ok) return;
  const edited = await performGitHubMutation({
    github: f.github,
    connectorAuthority: f.authority,
    authorized: {
      authorityKind: "MEMBER",
      actor,
      command: command(
        {
          kind: "EDIT_MILESTONE",
          milestone: { kind: "MILESTONE", repositoryId: "101", number: 1 },
          state: "CLOSED",
        },
        {
          kind: "EXACT_REVISION",
          sourceRevision: created.value.sourceRevision,
          comparableDigest: created.value.comparableDigest,
        },
      ),
    },
  });
  expect(edited).toMatchObject({ ok: true, value: { value: { state: "CLOSED" } } });
});
