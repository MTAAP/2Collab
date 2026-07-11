import type { Database } from "bun:sqlite";

export function verifyProjectsSchema(database: Database): void {
  const versions = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  if (versions.length !== 2 || versions[0]?.version !== 1 || versions[1]?.version !== 2) {
    throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
  }
  const columns = database
    .query<{ name: string }, []>("PRAGMA table_info(projects)")
    .all()
    .map((row) => row.name);
  if (!columns.includes("base_branch")) throw new Error("SCHEMA_INTEGRITY_INVALID");
  const strict = database.query<{ strict: number }, []>("PRAGMA table_list('projects')").get();
  if (strict?.strict !== 1) throw new Error("SCHEMA_INTEGRITY_INVALID");
}
