import type { Database } from "bun:sqlite";

const PROJECTS_SCHEMA_SHA256 = "3ed6b781c264f93de2d6231a194c711cb2152b3767b0d3be22f669d0a1d4e61d";

type Column = Readonly<{
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}>;

const EXPECTED_COLUMNS: readonly Column[] = [
  { cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
  { cid: 1, name: "team_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { cid: 2, name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { cid: 3, name: "base_branch", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { cid: 4, name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  { cid: 5, name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
];

function invalid(): never {
  throw new Error("SCHEMA_INTEGRITY_INVALID");
}

export function verifyProjectsTableSchema(database: Database): void {
  const columns = database.query<Column, []>("PRAGMA table_info(projects)").all();
  const table = database.query<{ strict: number }, []>("PRAGMA table_list('projects')").get();
  const tableSql = database
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
    )
    .get()?.sql;
  const foreignKeys = database
    .query<
      Readonly<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
        match: string;
      }>,
      []
    >("PRAGMA foreign_key_list(projects)")
    .all();
  if (
    table?.strict !== 1 ||
    JSON.stringify(columns) !== JSON.stringify(EXPECTED_COLUMNS) ||
    foreignKeys.length !== 1 ||
    foreignKeys[0]?.table !== "deployments" ||
    foreignKeys[0]?.from !== "team_id" ||
    foreignKeys[0]?.to !== "team_id" ||
    foreignKeys[0]?.on_update !== "NO ACTION" ||
    foreignKeys[0]?.on_delete !== "NO ACTION" ||
    foreignKeys[0]?.match !== "NONE" ||
    !tableSql
  ) {
    invalid();
  }
  const canonicalSql = tableSql
    .replace(/"projects"/g, "projects")
    .replace(/\s+/g, " ")
    .trim();
  const digest = new Bun.CryptoHasher("sha256").update(canonicalSql).digest("hex");
  if (digest !== PROJECTS_SCHEMA_SHA256) invalid();
}

export function verifyProjectsSchema(database: Database): void {
  const versions = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  if (versions.length < 2 || versions.some((row, index) => row.version !== index + 1)) {
    throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
  }
  verifyProjectsTableSchema(database);
}
