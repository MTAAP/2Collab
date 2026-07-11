import { expect, test } from "bun:test";
import { reconcileGitHubScope } from "../../src/server/adapters/github/reconciliation.ts";
import { StrictGitHubAdapter } from "../fixtures/github/strict-github-adapter.ts";

test("periodic reconciliation converges after a missed GitHub webhook", async () => {
  const github = StrictGitHubAdapter.seed({
    connectorId: "github_1",
    connectorEpoch: 1,
    selectedRepositoryIds: ["101"],
    selectedProjectIds: [],
  });
  github.addIssue({ repositoryId: "101", number: 42, title: "Initial" });
  github.replaceIssue({ repositoryId: "101", number: 42, title: "Changed outside Collab" });
  const titles: string[] = [];
  const result = await reconcileGitHubScope({
    github,
    scope: {
      projectId: "project_1" as never,
      connectorId: "github_1" as never,
      connectorEpoch: 1,
      references: ["ISSUE:101:42"],
      operations: ["INSPECT"],
    },
    connectorAuthority: {
      reconcileSource(event) {
        if (event.value.kind === "ISSUE") titles.push(event.value.title);
        return {
          ok: true,
          value: {
            value: event.value,
            reference: event.reference,
            sourceRevision: event.sourceRevision,
            comparableDigest: event.comparableDigest,
            projectionRevision: 1,
            observedAt: event.observedAt,
            freshness: event.freshness,
            provenance: {
              projectId: event.projectId,
              connectorId: event.connectorId,
              connectorEpoch: event.connectorEpoch,
              kind: event.provenance.kind,
            },
          },
        };
      },
    },
  });
  expect(result).toMatchObject({ ok: true, value: { scanned: 1 } });
  expect(titles).toEqual(["Changed outside Collab"]);
});
