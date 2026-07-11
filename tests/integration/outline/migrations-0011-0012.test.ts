import { Database } from "bun:sqlite";
import { test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import outline from "../../../src/server/db/migrations/0010_outline.sql" with { type: "text" };
import grants from "../../../src/server/db/migrations/0011_outline_grants.sql" with {
  type: "text",
};
import proposals from "../../../src/server/db/migrations/0012_outline_proposals.sql" with {
  type: "text",
};
import { verifyOutlineGrantSchema } from "../../../src/server/db/migrations/0011_outline_grants.verify.ts";
import { verifyOutlineProposalSchema } from "../../../src/server/db/migrations/0012_outline_proposals.verify.ts";
test("applies strict grant and proposal schemas after canonical reserved migrations", () => {
  const database = new Database(":memory:", { strict: true });
  try {
    migrate(database);
    database.exec("INSERT INTO schema_migrations(version,applied_at)VALUES(7,0),(8,0),(9,0)");
    database.exec(outline);
    database.exec(grants);
    database.exec(proposals);
    verifyOutlineGrantSchema(database);
    verifyOutlineProposalSchema(database);
  } finally {
    database.close();
  }
});
