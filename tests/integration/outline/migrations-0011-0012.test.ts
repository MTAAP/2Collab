import { Database } from "bun:sqlite";
import { test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import { expect } from "bun:test";
import { applyAndVerifyOutlineMigrations } from "../../../src/server/db/outline-migrations.ts";
import { verifyOutlineGrantSchema } from "../../../src/server/db/migrations/0011_outline_grants.verify.ts";
import { verifyOutlineProposalSchema } from "../../../src/server/db/migrations/0012_outline_proposals.verify.ts";
test("applies strict grant and proposal schemas after canonical reserved migrations", () => {
  const database = new Database(":memory:", { strict: true });
  try {
    migrate(database);
    applyAndVerifyOutlineMigrations(database);
    expect(
      database
        .query<{ version: number }, []>("SELECT max(version) AS version FROM schema_migrations")
        .get()?.version,
    ).toBe(15);
  } finally {
    database.close();
  }
});
test("rejects grant and proposal constraint drift", () => {
  const database = new Database(":memory:", { strict: true });
  try {
    migrate(database);
    database.exec(`
      PRAGMA foreign_keys=OFF;
      ALTER TABLE document_write_grants RENAME TO document_write_grants_drifted;
      CREATE TABLE document_write_grants(grant_id TEXT PRIMARY KEY) STRICT;
      ALTER TABLE document_proposals RENAME TO document_proposals_drifted;
      CREATE TABLE document_proposals(proposal_id TEXT PRIMARY KEY) STRICT;
    `);
    expect(() => verifyOutlineGrantSchema(database)).toThrow("SCHEMA_INTEGRITY_INVALID");
    expect(() => verifyOutlineProposalSchema(database)).toThrow("SCHEMA_INTEGRITY_INVALID");
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
