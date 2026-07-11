import { expect, test } from "bun:test";
import { dependencyWarning } from "../../../src/server/modules/github-coordination/dependencies.ts";

test("source dependencies remain advisory in every freshness state", () => {
  for (const freshness of ["FRESH", "STALE", "UNAVAILABLE"] as const) {
    const result = dependencyWarning({
      value: [],
      reference: "DEPENDENCIES:ISSUE:101:1",
      sourceRevision: "v1",
      comparableDigest: "a".repeat(64) as never,
      projectionRevision: 1,
      observedAt: 1,
      freshness,
      provenance: {
        projectId: "project_1" as never,
        connectorId: "github_1" as never,
        connectorEpoch: 1,
        kind: "RECONCILIATION",
      },
    });
    expect(result).toMatchObject({ freshness, blocksLaunch: false, changesRunState: false });
  }
});
