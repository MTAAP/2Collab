import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import { verifyOutlineSchema } from "../../../src/server/db/migrations/0010_outline.verify.ts";

test("creates strict reference-only Outline persistence after reserved connector migrations", () => {
  const database = new Database(":memory:", { strict: true });
  try {
    migrate(database);
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
