import type { Database } from "bun:sqlite";
import outlineMigration from "./0010_outline.sql" with { type: "text" };
import { verifyDeclaredSchema } from "./verify-declared-schema.ts";

export const OUTLINE_TABLES = [
  "outline_connections",
  "outline_member_oauth_grants",
  "outline_oauth_transactions",
  "outline_document_references",
  "outline_access_provenance",
  "connector_provider_bindings",
] as const;
export const OUTLINE_INDEXES = ["outline_access_provenance_actor"] as const;
export const CONNECTOR_PROVIDER_TRIGGERS = [
  "github_connector_provider_insert",
  "outline_connector_provider_insert",
  "connector_provider_binding_immutable_update",
  "connector_provider_binding_immutable_delete",
] as const;

export function verifyOutlineSchema(database: Database): void {
  verifyDeclaredSchema(database, outlineMigration, [
    ...OUTLINE_TABLES,
    ...OUTLINE_INDEXES,
    ...CONNECTOR_PROVIDER_TRIGGERS,
  ]);
  const collisions = database
    .query<{ count: number }, []>(
      `SELECT count(*) AS count FROM github_installations github
       JOIN outline_connections outline ON outline.connector_id = github.connector_id`,
    )
    .get()?.count;
  const wrongBindings = database
    .query<{ count: number }, []>(
      `SELECT count(*) AS count FROM (
         SELECT github.connector_id FROM github_installations github
         LEFT JOIN connector_provider_bindings binding ON binding.connector_id=github.connector_id
         WHERE binding.provider IS NOT 'GITHUB'
         UNION ALL
         SELECT outline.connector_id FROM outline_connections outline
         LEFT JOIN connector_provider_bindings binding ON binding.connector_id=outline.connector_id
         WHERE binding.provider IS NOT 'OUTLINE'
       )`,
    )
    .get()?.count;
  if (collisions !== 0 || wrongBindings !== 0) throw new Error("SCHEMA_INTEGRITY_INVALID");
  if (
    database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check !== "ok" ||
    database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all().length !== 0
  ) {
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
}
