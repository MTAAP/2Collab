import { expect, test } from "bun:test";
import {
  canonicalCoordinationRecord,
  coalesceCoordinationRecords,
} from "../../../src/server/modules/coordination-records/source-links.ts";
import { coordinationFixture, seedRun } from "./fixture.ts";

test("authorized coalescing preserves all run provenance behind a one-hop canonical alias", () => {
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
  expect(result).toMatchObject({ ok: true, value: { movedRuns: 0 } });
  expect(
    database
      .query<{ coordination_record_id: string }, [string]>(
        "SELECT coordination_record_id FROM agent_runs WHERE id = ?",
      )
      .get("run_active"),
  ).toEqual({ coordination_record_id: "record_b" });
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

test("coalescing rolls back every move when an injected write fails", () => {
  const database = coordinationFixture();
  seedRun(database, "run_active", "record_b", "QUEUED");
  const result = coalesceCoordinationRecords(database, {
    projectId: "project_1",
    aliasRecordId: "record_b",
    canonicalRecordId: "record_a",
    actorMemberId: "member_1",
    now: 10,
    afterWrite(table) {
      if (table === "coordination_record_aliases") throw new Error("injected");
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
