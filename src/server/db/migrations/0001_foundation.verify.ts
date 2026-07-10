import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../migrate.ts";

export function verifyFoundationSchema(db: Database): void {
  expect(
    db
      .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
      .all(),
  ).toEqual([{ version: 1 }]);
  expect(
    db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('deployments', 'members', 'audit_events')",
      )
      .get(),
  ).toEqual({ count: 3 });
  expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()).toEqual({
    foreign_keys: 1,
  });
}

test("0001 foundation migration verifies from an empty isolated database", () => {
  const db = new Database(":memory:", { strict: true });
  try {
    migrate(db);
    verifyFoundationSchema(db);
  } finally {
    db.close();
  }
});
