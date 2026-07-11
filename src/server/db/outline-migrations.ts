import type { Database } from "bun:sqlite";
import outline from "./migrations/0010_outline.sql" with { type: "text" };
import grants from "./migrations/0011_outline_grants.sql" with { type: "text" };
import proposals from "./migrations/0012_outline_proposals.sql" with { type: "text" };
import { verifyOutlineSchema } from "./migrations/0010_outline.verify.ts";
import { verifyOutlineGrantSchema } from "./migrations/0011_outline_grants.verify.ts";
import { verifyOutlineProposalSchema } from "./migrations/0012_outline_proposals.verify.ts";
import { inImmediateTransaction } from "./transaction.ts";

/**
 * Integration seam for the reserved Outline migrations. The main catalog must call this only after
 * GitHub has registered canonical versions 0007-0009; this helper intentionally does not fabricate
 * or renumber those versions.
 */
export function applyAndVerifyOutlineMigrations(database: Database): void {
  inImmediateTransaction(database, () => {
    const current =
      database
        .query<{ version: number }, []>(
          "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
        )
        .get()?.version ?? 0;
    if (current === 9) {
      database.exec(outline);
      database.exec(grants);
      database.exec(proposals);
    } else if (current !== 12) {
      throw new Error("OUTLINE_MIGRATION_PREREQUISITE_MISSING");
    }
    verifyOutlineSchema(database);
    verifyOutlineGrantSchema(database);
    verifyOutlineProposalSchema(database);
  });
}
