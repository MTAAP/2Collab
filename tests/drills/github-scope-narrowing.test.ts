import { expect, test } from "bun:test";
import { StrictGitHubAdapter } from "../fixtures/github/strict-github-adapter.ts";

test("scope narrowing advances epoch before denying new GitHub operations", async () => {
  const github = StrictGitHubAdapter.seed({
    connectorId: "github_1",
    connectorEpoch: 1,
    selectedRepositoryIds: ["101"],
    selectedProjectIds: [],
  });
  github.addIssue({ repositoryId: "101", number: 1, title: "Issue" });
  github.narrowScope({ repositoryIds: [], connectorEpoch: 2 });
  const result = await github.inspect(
    {
      projectId: "project_1" as never,
      connectorId: "github_1" as never,
      connectorEpoch: 1,
      references: ["ISSUE:101:1"],
      operations: ["INSPECT"],
    },
    { kind: "ISSUE", repositoryId: "101", number: 1 },
  );
  expect(result).toMatchObject({ ok: false, error: { code: "CONNECTOR_REVOKED" } });
});
