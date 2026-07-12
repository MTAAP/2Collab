import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { migrateRunnerDatabase } from "./migrate.ts";

function ensureDirectory(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, component);
    try {
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("RUNNER_STATE_UNSAFE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("RUNNER_STATE_UNSAFE");
    }
  }
  chmodSync(absolute, 0o700);
}

function canonicalFuturePath(input: string): string {
  let cursor = resolve(input);
  const missing: string[] = [];
  while (true) {
    try {
      const metadata = lstatSync(cursor);
      if (metadata.isSymbolicLink()) throw new Error("RUNNER_STATE_UNSAFE");
      cursor = realpathSync(cursor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error("RUNNER_STATE_UNSAFE");
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
  return missing.reduce((path, component) => join(path, component), cursor);
}

export function openRunnerDatabase(inputPath: string): Database {
  if (!isAbsolute(inputPath)) throw new Error("RUNNER_STATE_UNSAFE");
  const path = canonicalFuturePath(inputPath);
  ensureDirectory(dirname(path));
  let fresh = false;
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
      throw new Error("RUNNER_STATE_UNSAFE");
    }
    chmodSync(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const descriptor = openSync(path, "wx", 0o600);
    closeSync(descriptor);
    fresh = true;
  }
  let database: Database | undefined;
  try {
    database = new Database(path, { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA journal_mode = WAL");
    migrateRunnerDatabase(database, fresh);
    chmodSync(path, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        chmodSync(`${path}${suffix}`, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return database;
  } catch {
    database?.close();
    if (fresh) {
      for (const candidate of [path, `${path}-wal`, `${path}-shm`])
        rmSync(candidate, { force: true });
    }
    throw new Error("RUNNER_STATE_CORRUPT");
  }
}
