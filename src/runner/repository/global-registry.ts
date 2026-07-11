import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
} from "node:fs";
import type { Stats } from "node:fs";
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

export interface GlobalRegistryFilesystem {
  chmodSync(path: string, mode: number): void;
  closeSync(descriptor: number): void;
  fstatSync(descriptor: number): Stats;
  fsyncSync(descriptor: number): void;
  linkSync(existingPath: string, newPath: string): void;
  lstatSync(path: string): Stats;
  mkdirSync(path: string, options: { recursive: true; mode: number }): string | undefined;
  openSync(path: string, flags: string, mode?: number): number;
  rmSync(path: string, options: { force: true }): void;
}

const nodeFilesystem: GlobalRegistryFilesystem = {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
};

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
  const origin = CanonicalServerOriginSchema.safeParse(row.server_origin);
  const projectId = IdentifierSchema.safeParse(row.project_id);
  const teamId = IdentifierSchema.safeParse(row.team_id);
  const baseBranch = GitRefSchema.safeParse(row.base_branch);
  const configSha256 = Sha256Schema.safeParse(row.config_sha256);
  if (
    !origin.success ||
    origin.data !== row.server_origin ||
    !projectId.success ||
    !teamId.success ||
    !baseBranch.success ||
    !configSha256.success ||
    !isAbsolute(row.preferred_checkout) ||
    resolve(row.preferred_checkout) !== row.preferred_checkout ||
    !Number.isSafeInteger(row.registered_at) ||
    row.registered_at < 0 ||
    !Number.isSafeInteger(row.last_accessed_at) ||
    row.last_accessed_at < row.registered_at
  ) {
    throw new Error("PROJECT_REGISTRY_CORRUPT");
  }
  return {
    serverOrigin: origin.data,
    projectId: projectId.data,
    teamId: teamId.data,
    baseBranch: baseBranch.data,
    preferredCheckout: row.preferred_checkout,
    configSha256: configSha256.data,
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
  database.query<CheckoutRow, []>("SELECT * FROM project_checkouts").all().forEach(checkout);
}

function configureDatabase(database: Database): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  database.exec("PRAGMA journal_mode = WAL");
}

function sameNode(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function safeDirectory(filesystem: GlobalRegistryFilesystem, path: string): Stats {
  const metadata = filesystem.lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("PROJECT_REGISTRY_UNSAFE");
  }
  return metadata;
}

function safeFile(filesystem: GlobalRegistryFilesystem, path: string): Stats {
  const metadata = filesystem.lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("PROJECT_REGISTRY_UNSAFE");
  }
  return metadata;
}

function initializeDatabaseFile(
  path: string,
  filesystem: GlobalRegistryFilesystem,
  directoryIdentity: Stats,
): void {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.init.${Bun.randomUUIDv7()}`);
  if (!sameNode(directoryIdentity, safeDirectory(filesystem, directory))) {
    throw new Error("PROJECT_REGISTRY_UNSAFE");
  }
  const descriptor = filesystem.openSync(temporaryPath, "wx", 0o600);
  const temporaryIdentity = filesystem.fstatSync(descriptor);
  filesystem.closeSync(descriptor);
  let temporaryDatabase: Database | undefined;
  try {
    if (
      !sameNode(temporaryIdentity, safeFile(filesystem, temporaryPath)) ||
      !sameNode(directoryIdentity, safeDirectory(filesystem, directory))
    ) {
      throw new Error("PROJECT_REGISTRY_UNSAFE");
    }
    temporaryDatabase = new Database(temporaryPath, { strict: true });
    if (
      !sameNode(temporaryIdentity, safeFile(filesystem, temporaryPath)) ||
      !sameNode(directoryIdentity, safeDirectory(filesystem, directory))
    ) {
      throw new Error("PROJECT_REGISTRY_UNSAFE");
    }
    configureDatabase(temporaryDatabase);
    immediate(temporaryDatabase, () => temporaryDatabase?.exec(migration));
    verifySchema(temporaryDatabase);
    temporaryDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    temporaryDatabase.close();
    temporaryDatabase = undefined;
    filesystem.chmodSync(temporaryPath, 0o600);
    if (!sameNode(temporaryIdentity, safeFile(filesystem, temporaryPath))) {
      throw new Error("PROJECT_REGISTRY_UNSAFE");
    }
    const fileDescriptor = filesystem.openSync(temporaryPath, "r");
    try {
      if (!sameNode(temporaryIdentity, filesystem.fstatSync(fileDescriptor))) {
        throw new Error("PROJECT_REGISTRY_UNSAFE");
      }
      filesystem.fsyncSync(fileDescriptor);
    } finally {
      filesystem.closeSync(fileDescriptor);
    }
    if (!sameNode(directoryIdentity, safeDirectory(filesystem, directory))) {
      throw new Error("PROJECT_REGISTRY_UNSAFE");
    }
    try {
      filesystem.linkSync(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    safeFile(filesystem, path);
    if (!sameNode(directoryIdentity, safeDirectory(filesystem, directory))) {
      throw new Error("PROJECT_REGISTRY_UNSAFE");
    }
    const directoryDescriptor = filesystem.openSync(directory, "r");
    try {
      if (!sameNode(directoryIdentity, filesystem.fstatSync(directoryDescriptor))) {
        throw new Error("PROJECT_REGISTRY_UNSAFE");
      }
      filesystem.fsyncSync(directoryDescriptor);
      if (!sameNode(directoryIdentity, safeDirectory(filesystem, directory))) {
        throw new Error("PROJECT_REGISTRY_UNSAFE");
      }
    } finally {
      filesystem.closeSync(directoryDescriptor);
    }
  } finally {
    temporaryDatabase?.close();
    try {
      if (sameNode(directoryIdentity, safeDirectory(filesystem, directory))) {
        for (const candidate of [temporaryPath, `${temporaryPath}-wal`, `${temporaryPath}-shm`]) {
          filesystem.rmSync(candidate, { force: true });
        }
      }
    } catch {
      // Never follow a replaced parent merely to clean up temporary database files.
    }
  }
}

export function openLocalProjectRegistry(
  inputPath: string,
  dependencies: Readonly<{
    clock?: () => number;
    filesystem?: GlobalRegistryFilesystem;
  }> = {},
): LocalProjectRegistry {
  const path = resolve(inputPath);
  const directory = dirname(path);
  const clock = dependencies.clock ?? Date.now;
  const filesystem = dependencies.filesystem ?? nodeFilesystem;
  let database: Database | undefined;

  try {
    try {
      const directoryStat = filesystem.lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error("PROJECT_REGISTRY_UNSAFE");
      }
      filesystem.chmodSync(directory, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      filesystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
      filesystem.chmodSync(directory, 0o700);
    }
    const directoryIdentity = safeDirectory(filesystem, directory);

    try {
      const fileStat = filesystem.lstatSync(path);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new Error("PROJECT_REGISTRY_UNSAFE");
      }
      if (fileStat.size === 0) throw new Error("PROJECT_REGISTRY_CORRUPT");
      filesystem.chmodSync(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      initializeDatabaseFile(path, filesystem, directoryIdentity);
    }

    const fileIdentity = safeFile(filesystem, path);
    if (!sameNode(directoryIdentity, safeDirectory(filesystem, directory))) {
      throw new Error("PROJECT_REGISTRY_UNSAFE");
    }
    database = new Database(path, { strict: true });
    if (
      !sameNode(fileIdentity, safeFile(filesystem, path)) ||
      !sameNode(directoryIdentity, safeDirectory(filesystem, directory))
    ) {
      throw new Error("PROJECT_REGISTRY_UNSAFE");
    }
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
  const validateRows = (): void => {
    db.query<CheckoutRow, []>("SELECT * FROM project_checkouts").all().forEach(checkout);
  };

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
        validateRows();
        return immediate(db, () => {
          const existing = byKey.get(parsed.data.serverOrigin, parsed.data.projectId);
          const now = clock();
          if (existing) {
            checkout(existing);
            if (
              existing.preferred_checkout !== parsed.data.preferredCheckout &&
              options.replace !== true
            ) {
              throw new Error("PROJECT_MAPPING_CONFLICT");
            }
            if (
              existing.preferred_checkout === parsed.data.preferredCheckout &&
              (existing.team_id !== parsed.data.teamId ||
                existing.base_branch !== parsed.data.baseBranch)
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
      try {
        validateRows();
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
      } catch (error) {
        return translateStorageError(error);
      }
    },
    list() {
      try {
        validateRows();
        return db
          .query<CheckoutRow, []>(
            "SELECT * FROM project_checkouts ORDER BY server_origin, project_id",
          )
          .all()
          .map(checkout);
      } catch (error) {
        return translateStorageError(error);
      }
    },
    close() {
      db.close();
    },
  };
}
