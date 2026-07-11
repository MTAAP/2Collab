import { Database } from "bun:sqlite";
import { test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import { expect } from "bun:test";
import { applyAndVerifyOutlineMigrations } from "../../../src/server/db/outline-migrations.ts";
test("applies strict grant and proposal schemas after canonical reserved migrations", () => {
  const database = new Database(":memory:", { strict: true });
  try {
    migrate(database);
    applyAndVerifyOutlineMigrations(database);
    expect(
      database
        .query<{ version: number }, []>("SELECT max(version) AS version FROM schema_migrations")
        .get()?.version,
    ).toBe(12);
  } finally {
    database.close();
  }
});
test("the canonical catalog already includes and verifies Outline", () => {
  const database = new Database(":memory:", { strict: true });
  try {
    migrate(database);
    expect(() => applyAndVerifyOutlineMigrations(database)).not.toThrow();
  } finally {
    database.close();
  }
});
