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

test("reconciliation reports unchanged projections and returns the latest durable cursor", async () => {
  const events = [
    { marker: "cursor-1", changed: false },
    { marker: "cursor-2", changed: true },
  ];
  const result = await reconcileGitHubScope({
    github: {
      inspect: async () => ({
        ok: false,
        error: { code: "UNUSED", message: "Unused.", retry: "NEVER" },
      }),
      mutate: async () => ({
        ok: false,
        error: { code: "UNUSED", message: "Unused.", retry: "NEVER" },
      }),
      async *scan(scope) {
        for (const [index, event] of events.entries())
          yield {
            ok: true as const,
            value: {
              projectId: scope.projectId,
              connectorId: scope.connectorId,
              connectorEpoch: scope.connectorEpoch,
              idempotencyKey: `scan_${index}`,
              reference: `ISSUE:101:${index + 1}`,
              actionMarker: event.marker,
              sourceRevision: String(index + 1),
              comparableDigest: "a".repeat(64) as never,
              observedAt: 1,
              freshness: "FRESH" as const,
              provenance: { kind: "RECONCILIATION" as const },
              value: {
                kind: "ISSUE" as const,
                repositoryId: "101",
                number: index + 1,
                title: "Issue",
                state: "OPEN" as const,
                stateReason: null,
                labels: [],
                assignees: [],
                milestoneNumber: null,
                commentCount: 0,
              },
            },
          };
      },
      observeChecks: async () => ({
        ok: false,
        error: { code: "UNUSED", message: "Unused.", retry: "NEVER" },
      }),
      listDependencies: async () => ({
        ok: false,
        error: { code: "UNUSED", message: "Unused.", retry: "NEVER" },
      }),
    },
    scope: {
      projectId: "project_1" as never,
      connectorId: "github_1" as never,
      connectorEpoch: 1,
      references: ["ISSUE:101:1", "ISSUE:101:2"],
      operations: ["INSPECT"],
    },
    cursor: "cursor-old",
    connectorAuthority: {
      reconcileSource(event) {
        const changed = events.find((item) => item.marker === event.actionMarker)?.changed ?? true;
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
            reconciliationChanged: changed,
          },
        };
      },
    },
  });

  expect(result).toMatchObject({
    ok: true,
    value: { scanned: 2, updated: 1, unchanged: 1, cursor: "cursor-2" },
  });
});
