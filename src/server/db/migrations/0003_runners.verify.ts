import type { Database } from "bun:sqlite";

export const RUNNER_TABLES = [
  "runners",
  "runner_pairings",
  "runner_credentials",
  "runner_mapping_versions",
  "safe_profile_versions",
  "runner_exposure_acknowledgements",
  "runner_exposures",
  "runner_authority_change_outbox",
] as const;

export const RUNNER_INDEXES = [
  "one_active_runner_credential",
  "one_active_runner_mapping",
  "one_active_runner_exposure",
] as const;
export const RUNNER_TRIGGERS = [
  "runners_owner_immutable",
  "runner_mapping_facts_immutable",
  "safe_profile_versions_append_only",
  "runner_acknowledgement_content_immutable",
] as const;

const RUNNER_SCHEMA_SHA256 = "09a05c05265830dd426c822d713c1f17af43d005cb865df2ec7a523df9463a83";
const RUNNER_METADATA_SHA256 = "fdf26cbd5eed9b5ac03da148c8694312d5a9722abf04f7167e553fc0f495ea41";

function invalid(): never {
  throw new Error("SCHEMA_INTEGRITY_INVALID");
}

export function verifyRunnersSchema(database: Database): void {
  const versions = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  if (versions.length < 3 || versions.some((row, index) => row.version !== index + 1)) {
    throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
  }
  for (const [type, expected] of [
    ["table", RUNNER_TABLES],
    ["index", RUNNER_INDEXES],
    ["trigger", RUNNER_TRIGGERS],
  ] as const) {
    const names = new Set(
      database
        .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = ?")
        .all(type)
        .map((row) => row.name),
    );
    if (expected.some((name) => !names.has(name))) invalid();
  }
  for (const table of RUNNER_TABLES) {
    if (
      database.query<{ strict: number }, []>(`PRAGMA table_list('${table}')`).get()?.strict !== 1
    ) {
      invalid();
    }
  }
  const objectNames = [...RUNNER_TABLES, ...RUNNER_INDEXES, ...RUNNER_TRIGGERS];
  const canonicalObjects = database
    .query<{ type: string; name: string; sql: string }, string[]>(
      `SELECT type, name, sql FROM sqlite_master
       WHERE name IN (${objectNames.map(() => "?").join(",")})
       ORDER BY type, name`,
    )
    .all(...objectNames)
    .map((row) => ({ ...row, sql: row.sql.replace(/\s+/g, " ").trim() }));
  const schemaDigest = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(canonicalObjects))
    .digest("hex");
  if (schemaDigest !== RUNNER_SCHEMA_SHA256) invalid();

  const metadata = {
    tables: Object.fromEntries(
      RUNNER_TABLES.map((table) => [
        table,
        {
          columns: database.query(`PRAGMA table_xinfo(${JSON.stringify(table)})`).all(),
          foreignKeys: database.query(`PRAGMA foreign_key_list(${JSON.stringify(table)})`).all(),
        },
      ]),
    ),
    indexes: Object.fromEntries(
      RUNNER_INDEXES.map((index) => [
        index,
        database.query(`PRAGMA index_xinfo(${JSON.stringify(index)})`).all(),
      ]),
    ),
  };
  const metadataDigest = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(metadata))
    .digest("hex");
  if (metadataDigest !== RUNNER_METADATA_SHA256) invalid();
  if (
    database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check !== "ok"
  ) {
    invalid();
  }
  if (database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all().length !== 0) {
    invalid();
  }
}
