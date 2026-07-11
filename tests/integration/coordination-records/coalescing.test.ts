import { expect, test } from "bun:test";
import {
  canonicalCoordinationRecord,
  coalesceCoordinationRecords,
} from "../../../src/server/modules/coordination-records/source-links.ts";
import { coordinationFixture, seedRun } from "./fixture.ts";

test("authorized coalescing moves nonterminal work and preserves completed provenance", () => {
  const database = coordinationFixture();
  seedRun(database, "run_active", "record_b", "QUEUED");
  seedRun(database, "run_complete", "record_b", "COMPLETED");
  const result = coalesceCoordinationRecords(database, {
    projectId: "project_1",
    aliasRecordId: "record_b",
    canonicalRecordId: "record_a",
    actorMemberId: "member_1",
    now: 10,
  });
  expect(result).toMatchObject({ ok: true, value: { movedRuns: 1 } });
  expect(
    database
      .query<{ coordination_record_id: string }, [string]>(
        "SELECT coordination_record_id FROM agent_runs WHERE id = ?",
      )
      .get("run_active"),
  ).toEqual({ coordination_record_id: "record_a" });
  expect(
    database
      .query<{ coordination_record_id: string }, [string]>(
        "SELECT coordination_record_id FROM agent_runs WHERE id = ?",
      )
      .get("run_complete"),
  ).toEqual({ coordination_record_id: "record_b" });
  expect(canonicalCoordinationRecord(database, "project_1", "record_b")).toBe("record_a");
  database.close();
});

for (const failureTable of [
  "coordination_coalescing_permits",
  "coordination_source_references",
  "work_item_mutation_guards",
  "mutation_guard_overrides",
  "agent_runs",
  "coordination_record_aliases",
]) {
  test(`coalescing rolls back every move when ${failureTable} fails`, () => {
    const database = coordinationFixture();
    seedRun(database, "run_active", "record_b", "QUEUED");
    const result = coalesceCoordinationRecords(database, {
      projectId: "project_1",
      aliasRecordId: "record_b",
      canonicalRecordId: "record_a",
      actorMemberId: "member_1",
      now: 10,
      afterWrite(table) {
        if (table === failureTable) throw new Error("injected");
      },
    });
    expect(result.ok).toBe(false);
    expect(
      database
        .query<{ coordination_record_id: string }, []>(
          "SELECT coordination_record_id FROM agent_runs WHERE id = 'run_active'",
        )
        .get(),
    ).toEqual({ coordination_record_id: "record_b" });
    expect(
      database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM coordination_record_aliases")
        .get(),
    ).toEqual({ count: 0 });
    database.close();
  });
}
