import type { Database } from "bun:sqlite";

type SchemaObjectKind = "table" | "index" | "trigger";

function normalize(sql: string): string {
  return sql
    .trim()
    .replace(/;$/, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=<>])\s*/g, "$1")
    .toLowerCase();
}

function declaredObjects(
  source: string,
): ReadonlyMap<string, Readonly<{ kind: SchemaObjectKind; sql: string }>> {
  const objects = new Map<string, Readonly<{ kind: SchemaObjectKind; sql: string }>>();
  const headerPattern =
    /CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?([A-Za-z0-9_]+)/gi;
  for (let header = headerPattern.exec(source); header; header = headerPattern.exec(source)) {
    if (!header) throw new Error("SCHEMA_DECLARATION_INVALID");
    const kind = (header[1] as string).toLowerCase() as SchemaObjectKind;
    const remainder = source.slice(header.index);
    const end = kind === "trigger" ? /\nEND\s*;/i.exec(remainder) : /;/.exec(remainder);
    if (!end) throw new Error("SCHEMA_DECLARATION_INVALID");
    const statement = remainder.slice(0, end.index + end[0].length);
    objects.set(header[2] as string, {
      kind,
      sql: normalize(statement),
    });
  }
  return objects;
}

/** Compares SQLite's canonical stored DDL to the checked-in migration, including every column,
 * constraint, foreign key, index, and trigger declared by that migration. */
export function verifyDeclaredSchema(
  database: Database,
  source: string,
  expectedNames: readonly string[],
): void {
  const expected = declaredObjects(source);
  for (const name of expectedNames) {
    const declaration = expected.get(name);
    const actual = database
      .query<{ type: string; sql: string | null }, [string]>(
        "SELECT type, sql FROM sqlite_master WHERE name = ?",
      )
      .get(name);
    if (
      !declaration ||
      !actual?.sql ||
      actual.type !== declaration.kind ||
      normalize(actual.sql) !== declaration.sql
    ) {
      throw new Error("SCHEMA_INTEGRITY_INVALID");
    }
    if (
      declaration.kind === "table" &&
      database.query<{ strict: number }, []>(`PRAGMA table_list('${name}')`).get()?.strict !== 1
    ) {
      throw new Error("SCHEMA_INTEGRITY_INVALID");
    }
  }
}
