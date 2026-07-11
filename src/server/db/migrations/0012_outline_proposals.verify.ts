import type { Database } from "bun:sqlite";
import proposalMigration from "./0012_outline_proposals.sql" with { type: "text" };
import { verifyDeclaredSchema } from "./verify-declared-schema.ts";
export const OUTLINE_PROPOSAL_TABLES = [
  "document_proposals",
  "document_conflicts",
  "document_proposal_decisions",
  "external_working_documents",
  "working_document_dispositions",
] as const;
export function verifyOutlineProposalSchema(database: Database) {
  verifyDeclaredSchema(database, proposalMigration, OUTLINE_PROPOSAL_TABLES);
}
