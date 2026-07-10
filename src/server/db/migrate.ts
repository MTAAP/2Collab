import type { Database } from "bun:sqlite";
import foundationMigration from "./migrations/0001_foundation.sql" with { type: "text" };
import { inImmediateTransaction } from "./transaction.ts";

const LATEST_SCHEMA_VERSION = 1;

type SchemaVersion = Readonly<{ version: number }>;

export function migrate(database: Database): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
    ) STRICT
  `);

  const versions = database
    .query<SchemaVersion, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  const currentVersion = versions.at(-1)?.version ?? 0;

  if (currentVersion > LATEST_SCHEMA_VERSION) {
    throw new Error("SCHEMA_VERSION_NEWER_THAN_SUPPORTED");
  }
  if (currentVersion === LATEST_SCHEMA_VERSION) {
    return;
  }

  inImmediateTransaction(database, () => {
    database.exec(foundationMigration);
  });
}
