import type { Database } from "bun:sqlite";
import grantMigration from "./0011_outline_grants.sql" with { type: "text" };
import { verifyDeclaredSchema } from "./verify-declared-schema.ts";
export const OUTLINE_GRANT_TABLES = [
  "document_write_grants",
  "document_write_grant_documents",
  "document_write_grant_operations",
  "additional_document_requests",
] as const;
export function verifyOutlineGrantSchema(database: Database): void {
  verifyDeclaredSchema(database, grantMigration, OUTLINE_GRANT_TABLES);
}
