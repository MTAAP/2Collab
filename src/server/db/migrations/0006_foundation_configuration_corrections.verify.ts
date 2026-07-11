import type { Database } from "bun:sqlite";
import {
  FOUNDATION_OPERATION_EXPECTED_COLUMNS,
  FOUNDATION_OPERATION_INDEXES,
  FOUNDATION_OPERATION_TABLES,
  FOUNDATION_OPERATION_TRIGGERS,
} from "./0005_foundation_operations.verify.ts";

export const FOUNDATION_CONFIGURATION_TABLES = [
  ...FOUNDATION_OPERATION_TABLES,
  "execution_attempt_causes",
] as const;
export const FOUNDATION_CONFIGURATION_INDEXES = [
  ...FOUNDATION_OPERATION_INDEXES,
  "execution_attempt_causes_kind",
] as const;
export const FOUNDATION_CONFIGURATION_TRIGGERS = [
  ...FOUNDATION_OPERATION_TRIGGERS,
  "execution_attempt_cause_immutable",
  "execution_attempt_cause_delete_denied",
] as const;

const EXPECTED_COLUMNS: Readonly<
  Record<(typeof FOUNDATION_CONFIGURATION_TABLES)[number], readonly string[]>
> = {
  ...FOUNDATION_OPERATION_EXPECTED_COLUMNS,
  execution_attempt_causes: [
    "attempt_id",
    "cause_kind",
    "predecessor_attempt_id",
    "checkpoint_id",
    "approval_subject_id",
    "managed_loop_iteration",
    "created_at",
  ],
};

const FOUNDATION_CONFIGURATION_SCHEMA_SHA256 =
  "e2abf315beb4aaf95a8527a30b84eb0c4f9bb87e84f1097d858c6e3c5dc83b4c";

function names(database: Database, type: "index" | "table" | "trigger"): Set<string> {
  return new Set(
    database
      .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = ?")
      .all(type)
      .map((row) => row.name),
  );
}

export function verifyFoundationConfigurationCorrectionsSchema(database: Database): void {
  const versions = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => row.version);
  if (
    versions.length < 6 ||
    versions.slice(0, 6).join(",") !== "1,2,3,4,5,6" ||
    versions.some((version, index) => version !== index + 1)
  ) {
    throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
  }
  for (const [type, expected] of [
    ["table", FOUNDATION_CONFIGURATION_TABLES],
    ["index", FOUNDATION_CONFIGURATION_INDEXES],
    ["trigger", FOUNDATION_CONFIGURATION_TRIGGERS],
  ] as const) {
    const actual = names(database, type);
    if (expected.some((name) => !actual.has(name))) throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
  for (const table of FOUNDATION_CONFIGURATION_TABLES) {
    const columns = database
      .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
      .all()
      .map((row) => row.name);
    if (
      database.query<{ strict: number }, []>(`PRAGMA table_list('${table}')`).get()?.strict !== 1 ||
      columns.join(",") !== EXPECTED_COLUMNS[table].join(",")
    ) {
      throw new Error("SCHEMA_INTEGRITY_INVALID");
    }
  }
  const objectNames = [
    ...FOUNDATION_CONFIGURATION_TABLES,
    ...FOUNDATION_CONFIGURATION_INDEXES,
    ...FOUNDATION_CONFIGURATION_TRIGGERS,
  ];
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
  if (schemaDigest !== FOUNDATION_CONFIGURATION_SCHEMA_SHA256) {
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
  if (
    database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check !== "ok" ||
    database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all().length !== 0
  ) {
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
}
