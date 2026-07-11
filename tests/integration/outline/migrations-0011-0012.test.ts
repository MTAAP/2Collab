import { Database } from "bun:sqlite";
import { test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import { expect } from "bun:test";
import { applyAndVerifyOutlineMigrations } from "../../../src/server/db/outline-migrations.ts";
test("applies strict grant and proposal schemas after canonical reserved migrations", () => {
  const database = new Database(":memory:", { strict: true });
  try {
    migrate(database);
    database.exec("INSERT INTO schema_migrations(version,applied_at)VALUES(7,0),(8,0),(9,0)");
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
test("refuses to register Outline ahead of the canonical GitHub migration range", () => {
  const database = new Database(":memory:", { strict: true });
  try {
    migrate(database);
    expect(() => applyAndVerifyOutlineMigrations(database)).toThrow(
      "OUTLINE_MIGRATION_PREREQUISITE_MISSING",
    );
  } finally {
    database.close();
  }
});
