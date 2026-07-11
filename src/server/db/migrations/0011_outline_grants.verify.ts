import type { Database } from "bun:sqlite";
export const OUTLINE_GRANT_TABLES = [
  "document_write_grants",
  "document_write_grant_documents",
  "document_write_grant_operations",
  "additional_document_requests",
] as const;
export function verifyOutlineGrantSchema(database: Database): void {
  const names = new Set(
    database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name),
  );
  if (OUTLINE_GRANT_TABLES.some((name) => !names.has(name)))
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  for (const table of OUTLINE_GRANT_TABLES)
    if (database.query<{ strict: number }, []>(`PRAGMA table_list('${table}')`).get()?.strict !== 1)
      throw new Error("SCHEMA_INTEGRITY_INVALID");
}
