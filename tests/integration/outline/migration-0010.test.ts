import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import outlineMigration from "../../../src/server/db/migrations/0010_outline.sql" with {
  type: "text",
};
import { verifyOutlineSchema } from "../../../src/server/db/migrations/0010_outline.verify.ts";

test("creates strict reference-only Outline persistence after reserved connector migrations", () => {
  const database = new Database(":memory:", { strict: true });
  try {
    migrate(database);
    database.exec("INSERT INTO schema_migrations(version, applied_at) VALUES (7,0),(8,0),(9,0)");
    database.exec(outlineMigration);
    verifyOutlineSchema(database);
    const columns = database
      .query<{ name: string }, []>("PRAGMA table_info('outline_document_references')")
      .all()
      .map((row) => row.name);
    expect(columns).not.toContain("body");
    expect(columns).not.toContain("snippet");
  } finally {
    database.close();
  }
});
