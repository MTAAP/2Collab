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

test("rejects Outline schema drift rather than trusting table names", () => {
  const database = new Database(":memory:", { strict: true });
  try {
    migrate(database);
    database.exec(`
      PRAGMA foreign_keys=OFF;
      ALTER TABLE outline_connections RENAME TO outline_connections_drifted;
      CREATE TABLE outline_connections(connector_id TEXT PRIMARY KEY) STRICT;
    `);
    expect(() => verifyOutlineSchema(database)).toThrow("SCHEMA_INTEGRITY_INVALID");
  } finally {
    database.close();
  }
});
