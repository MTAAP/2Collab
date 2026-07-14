import type { Database } from "bun:sqlite";

export function inImmediateTransaction<T>(database: Database, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
