import type { Database } from "bun:sqlite";
export const OUTLINE_PROPOSAL_TABLES = [
  "document_proposals",
  "document_conflicts",
  "document_proposal_decisions",
  "external_working_documents",
  "working_document_dispositions",
] as const;
export function verifyOutlineProposalSchema(database: Database) {
  const names = new Set(
    database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name),
  );
  if (OUTLINE_PROPOSAL_TABLES.some((name) => !names.has(name)))
    throw new Error("SCHEMA_INTEGRITY_INVALID");
}
