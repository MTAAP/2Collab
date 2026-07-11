import type { Database } from "bun:sqlite";

export const OUTLINE_TABLES = [
  "outline_connections",
  "outline_member_oauth_grants",
  "outline_oauth_transactions",
  "outline_document_references",
  "outline_access_provenance",
] as const;

export function verifyOutlineSchema(database: Database): void {
  const tables = new Set(
    database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  if (OUTLINE_TABLES.some((table) => !tables.has(table))) {
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
  for (const table of OUTLINE_TABLES) {
    if (
      database.query<{ strict: number }, []>(`PRAGMA table_list('${table}')`).get()?.strict !== 1
    ) {
      throw new Error("SCHEMA_INTEGRITY_INVALID");
    }
  }
  if (
    database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check !== "ok" ||
    database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all().length !== 0
  ) {
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
}
