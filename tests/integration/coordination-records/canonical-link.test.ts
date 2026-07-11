import { expect, test } from "bun:test";
import { linkSourceReferences } from "../../../src/server/modules/coordination-records/source-links.ts";
import { coordinationFixture } from "./fixture.ts";

test("late-link race selects one canonical Coordination Record", () => {
  const database = coordinationFixture();
  const source = {
    kind: "GITHUB_ISSUE" as const,
    connectorId: "github_1" as never,
    sourceItemId: "101:42",
    observedRevision: "etag-1",
  };
  const results = ["record_a", "record_b"].map((record) => {
    try {
      linkSourceReferences(database, {
        coordinationRecordId: record,
        projectId: "project_1",
        sourceRefs: [source],
        linkedAt: 1,
      });
      return true;
    } catch {
      return false;
    }
  });
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(
    database
      .query<{ coordination_record_id: string }, []>(
        "SELECT coordination_record_id FROM coordination_source_references",
      )
      .get(),
  ).toEqual({ coordination_record_id: "record_a" });
  database.close();
});
