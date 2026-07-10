import { Database } from "bun:sqlite";

const BUSY_TIMEOUT_MS = 5_000;

export function openDatabase(path: string): Database {
  const database = new Database(path, { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  if (path !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
  }
  return database;
}
