import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { IdentifierSchema, Sha256Schema } from "../../shared/contracts/ids.ts";
import { CanonicalServerOriginSchema, type GitRef } from "../../shared/contracts/projects.ts";
import { GitRefSchema } from "../../shared/contracts/runners.ts";
import migration from "./migrations/0001_global_registry.sql" with { type: "text" };

const LATEST_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;

export type ProjectCheckout = Readonly<{
  serverOrigin: string;
  projectId: string;
  teamId: string;
  baseBranch: GitRef;
  preferredCheckout: string;
  configSha256: string;
  registeredAt: number;
  lastAccessedAt: number;
}>;

export type RegisterProjectCheckout = Omit<ProjectCheckout, "registeredAt" | "lastAccessedAt">;

export interface LocalProjectRegistry {
  readonly database: Database;
  register(
    input: RegisterProjectCheckout,
    options?: Readonly<{ replace?: boolean }>,
  ): ProjectCheckout;
  lookup(
    input: Readonly<{ projectId: string; serverOrigin?: string }>,
  ): ProjectCheckout | undefined;
  list(): readonly ProjectCheckout[];
  close(): void;
}

const RegisterSchema = z
  .object({
    serverOrigin: CanonicalServerOriginSchema,
    projectId: IdentifierSchema,
    teamId: IdentifierSchema,
    baseBranch: GitRefSchema,
    preferredCheckout: z.string().min(1).max(4_096),
    configSha256: Sha256Schema,
  })
  .strict();

type CheckoutRow = Readonly<{
  server_origin: string;
  project_id: string;
  team_id: string;
  base_branch: string;
  preferred_checkout: string;
  config_sha256: string;
  registered_at: number;
  last_accessed_at: number;
}>;

function checkout(row: CheckoutRow): ProjectCheckout {
  return {
    serverOrigin: row.server_origin,
    projectId: row.project_id,
    teamId: row.team_id,
    baseBranch: row.base_branch,
    preferredCheckout: row.preferred_checkout,
    configSha256: row.config_sha256,
    registeredAt: row.registered_at,
    lastAccessedAt: row.last_accessed_at,
  };
}

function translateStorageError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (/busy|locked/i.test(message)) throw new Error("PROJECT_REGISTRY_BUSY");
  if (/UNIQUE constraint failed/i.test(message)) throw new Error("PROJECT_MAPPING_CONFLICT");
  if (message.startsWith("PROJECT_")) throw error;
  throw new Error("PROJECT_REGISTRY_CORRUPT");
}

function immediate<T>(database: Database, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original stable storage failure.
    }
    throw error;
  }
}

function validateHistory(database: Database): number {
  const rows = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  for (const [index, row] of rows.entries()) {
    if (row.version !== index + 1) throw new Error("PROJECT_REGISTRY_CORRUPT");
  }
  const version = rows.at(-1)?.version ?? 0;
  if (version > LATEST_VERSION) throw new Error("PROJECT_REGISTRY_VERSION_UNSUPPORTED");
  return version;
}

function verifySchema(database: Database): void {
  const version = validateHistory(database);
  if (version !== LATEST_VERSION) throw new Error("PROJECT_REGISTRY_CORRUPT");
  const columns = database
    .query<{ name: string }, []>("PRAGMA table_info(project_checkouts)")
    .all()
    .map((row) => row.name);
  const table = database
    .query<{ strict: number }, []>("PRAGMA table_list('project_checkouts')")
    .get();
  const tableSql = database
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_checkouts'",
    )
    .get()?.sql;
  const uniqueCheckout = database
    .query<{ unique: number }, []>("PRAGMA index_list(project_checkouts)")
    .all()
    .some((index) => index.unique === 1);
  if (
    table?.strict !== 1 ||
    !uniqueCheckout ||
    !tableSql?.includes("preferred_checkout TEXT NOT NULL UNIQUE") ||
    ![
      "server_origin",
      "project_id",
      "team_id",
      "base_branch",
      "preferred_checkout",
      "config_sha256",
      "registered_at",
      "last_accessed_at",
    ].every((column) => columns.includes(column))
  ) {
    throw new Error("PROJECT_REGISTRY_CORRUPT");
  }
  const integrity = database.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
  const foreignKeyFailures = database
    .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
    .all();
  if (integrity?.quick_check !== "ok" || foreignKeyFailures.length !== 0) {
    throw new Error("PROJECT_REGISTRY_CORRUPT");
  }
}

function configureDatabase(database: Database): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  database.exec("PRAGMA journal_mode = WAL");
}

function initializeDatabaseFile(path: string): void {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.init.${Bun.randomUUIDv7()}`);
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  closeSync(descriptor);
  let temporaryDatabase: Database | undefined;
  try {
    temporaryDatabase = new Database(temporaryPath, { strict: true });
    configureDatabase(temporaryDatabase);
    immediate(temporaryDatabase, () => temporaryDatabase?.exec(migration));
    verifySchema(temporaryDatabase);
    temporaryDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    temporaryDatabase.close();
    temporaryDatabase = undefined;
    chmodSync(temporaryPath, 0o600);
    const fileDescriptor = openSync(temporaryPath, "r");
    try {
      fsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }
    try {
      linkSync(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    temporaryDatabase?.close();
    for (const candidate of [temporaryPath, `${temporaryPath}-wal`, `${temporaryPath}-shm`]) {
      rmSync(candidate, { force: true });
    }
  }
}

export function openLocalProjectRegistry(
  inputPath: string,
  dependencies: Readonly<{ clock?: () => number }> = {},
): LocalProjectRegistry {
  const path = resolve(inputPath);
  const directory = dirname(path);
  const clock = dependencies.clock ?? Date.now;
  let database: Database | undefined;

  try {
    try {
      const directoryStat = lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error("PROJECT_REGISTRY_UNSAFE");
      }
      chmodSync(directory, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }

    try {
      const fileStat = lstatSync(path);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new Error("PROJECT_REGISTRY_UNSAFE");
      }
      if (fileStat.size === 0) throw new Error("PROJECT_REGISTRY_CORRUPT");
      chmodSync(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      initializeDatabaseFile(path);
    }

    database = new Database(path, { strict: true });
    configureDatabase(database);
    const hasLedger = database
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get()?.count;
    if (hasLedger !== 1) throw new Error("PROJECT_REGISTRY_CORRUPT");
    verifySchema(database);
  } catch (error) {
    database?.close();
    return translateStorageError(error);
  }

  const db = database;
  const byKey = db.query<CheckoutRow, [string, string]>(
    "SELECT * FROM project_checkouts WHERE server_origin = ? AND project_id = ?",
  );

  return {
    database: db,
    register(input, options = {}) {
      const parsed = RegisterSchema.safeParse(input);
      if (
        !parsed.success ||
        parsed.data.serverOrigin !== input.serverOrigin ||
        !isAbsolute(input.preferredCheckout) ||
        resolve(input.preferredCheckout) !== input.preferredCheckout
      ) {
        throw new Error("PROJECT_MAPPING_INVALID");
      }
      try {
        return immediate(db, () => {
          const existing = byKey.get(parsed.data.serverOrigin, parsed.data.projectId);
          const now = clock();
          if (existing) {
            if (
              existing.preferred_checkout !== parsed.data.preferredCheckout &&
              options.replace !== true
            ) {
              throw new Error("PROJECT_MAPPING_CONFLICT");
            }
            if (
              existing.preferred_checkout === parsed.data.preferredCheckout &&
              (existing.team_id !== parsed.data.teamId ||
                existing.base_branch !== parsed.data.baseBranch ||
                existing.config_sha256 !== parsed.data.configSha256)
            ) {
              throw new Error("PROJECT_MAPPING_CONFLICT");
            }
            db.query<void, [string, string, string, string, number, string, string]>(
              `UPDATE project_checkouts SET team_id = ?, base_branch = ?, preferred_checkout = ?,
                 config_sha256 = ?, last_accessed_at = ?
               WHERE server_origin = ? AND project_id = ?`,
            ).run(
              parsed.data.teamId,
              parsed.data.baseBranch,
              parsed.data.preferredCheckout,
              parsed.data.configSha256,
              now,
              parsed.data.serverOrigin,
              parsed.data.projectId,
            );
          } else {
            db.query<void, [string, string, string, string, string, string, number, number]>(
              `INSERT INTO project_checkouts(
                 server_origin, project_id, team_id, base_branch, preferred_checkout,
                 config_sha256, registered_at, last_accessed_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              parsed.data.serverOrigin,
              parsed.data.projectId,
              parsed.data.teamId,
              parsed.data.baseBranch,
              parsed.data.preferredCheckout,
              parsed.data.configSha256,
              now,
              now,
            );
          }
          const row = byKey.get(parsed.data.serverOrigin, parsed.data.projectId);
          if (!row) throw new Error("PROJECT_REGISTRY_CORRUPT");
          return checkout(row);
        });
      } catch (error) {
        return translateStorageError(error);
      }
    },
    lookup(input) {
      const projectId = IdentifierSchema.safeParse(input.projectId);
      if (!projectId.success) throw new Error("PROJECT_MAPPING_INVALID");
      if (input.serverOrigin !== undefined) {
        const origin = CanonicalServerOriginSchema.safeParse(input.serverOrigin);
        if (!origin.success || origin.data !== input.serverOrigin) {
          throw new Error("PROJECT_MAPPING_INVALID");
        }
        const row = byKey.get(origin.data, projectId.data);
        return row ? checkout(row) : undefined;
      }
      const rows = db
        .query<CheckoutRow, [string]>(
          "SELECT * FROM project_checkouts WHERE project_id = ? ORDER BY server_origin",
        )
        .all(projectId.data);
      if (rows.length > 1) throw new Error("PROJECT_AMBIGUOUS");
      return rows[0] ? checkout(rows[0]) : undefined;
    },
    list() {
      return db
        .query<CheckoutRow, []>(
          "SELECT * FROM project_checkouts ORDER BY server_origin, project_id",
        )
        .all()
        .map(checkout);
    },
    close() {
      db.close();
    },
  };
}
