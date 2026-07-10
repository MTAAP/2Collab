import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDatabase } from "../../../src/server/db/connection.ts";
import { migrate } from "../../../src/server/db/migrate.ts";
import { verifyFoundationSchema } from "../../../src/server/db/migrations/0001_foundation.verify.ts";
import { inImmediateTransaction } from "../../../src/server/db/transaction.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function memoryDatabase(): Database {
  return new Database(":memory:", { strict: true });
}

function expectConstraint(db: Database, statement: string): void {
  expect(() => db.exec(statement)).toThrow();
}

describe("openDatabase", () => {
  test("enables foreign keys and a busy timeout without changing in-memory journal mode", () => {
    const db = openDatabase(":memory:");
    try {
      expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
      expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()).toEqual({
        timeout: 5_000,
      });
      expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "memory",
      });
    } finally {
      db.close();
    }
  });

  test("enables WAL for a file database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "2collab-db-"));
    temporaryDirectories.push(directory);
    const db = openDatabase(join(directory, "collab.sqlite"));
    try {
      expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
    } finally {
      db.close();
    }
  });
});

describe("migrate", () => {
  test("creates the complete version 1 foundation schema idempotently", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      migrate(db);
      verifyFoundationSchema(db);

      const names = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => row.name);

      expect(names).toEqual(
        expect.arrayContaining([
          "audit_events",
          "connector_epochs",
          "deployments",
          "encrypted_credentials",
          "idempotency_results",
          "invitations",
          "member_credentials",
          "members",
          "projects",
          "schema_migrations",
          "sessions",
        ]),
      );
      expect(
        db
          .query<{ version: number; applied_at: number }, []>(
            "SELECT version, applied_at FROM schema_migrations",
          )
          .all(),
      ).toEqual([{ version: 1, applied_at: expect.any(Number) }]);
      expect(
        db.query<{ count: number }, []>("SELECT count(*) AS count FROM schema_migrations").get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  test("allows one deployment and rejects a second singleton deployment", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      db.exec(
        "INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES ('deployment_1', 1, 'team_1', 1, 0)",
      );
      expectConstraint(
        db,
        "INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES ('deployment_2', 1, 'team_2', 1, 0)",
      );
      expect(
        db.query<{ count: number }, []>("SELECT count(*) AS count FROM deployments").get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  test("enforces positive mutable revisions and epochs", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      expectConstraint(
        db,
        "INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES ('deployment_1', 1, 'team_1', 0, 0)",
      );
      expectConstraint(
        db,
        "INSERT INTO members(id, role, status, authority_epoch, revision, created_at) VALUES ('member_1', 'OWNER', 'ACTIVE', 0, 1, 0)",
      );
      expectConstraint(
        db,
        "INSERT INTO members(id, role, status, authority_epoch, revision, created_at) VALUES ('member_1', 'OWNER', 'ACTIVE', 1, 0, 0)",
      );
      expectConstraint(
        db,
        "INSERT INTO connector_epochs(connector_id, epoch, review_state) VALUES ('connector_1', 0, 'READY')",
      );
      expectConstraint(
        db,
        "INSERT INTO projects(id, team_id, name, revision, created_at) VALUES ('project_1', 'team_1', 'Project', -1, 0)",
      );
    } finally {
      db.close();
    }
  });

  test("enforces nonnegative timestamps", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      expectConstraint(
        db,
        "INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES ('deployment_1', 1, 'team_1', 1, -1)",
      );
      expectConstraint(
        db,
        "INSERT INTO audit_events(id, kind, actor_kind, actor_id, safe_details, created_at) VALUES ('audit_1', 'BOOTSTRAP', 'MEMBER', 'member_1', '{}', -1)",
      );
      expectConstraint(
        db,
        "INSERT INTO idempotency_results(actor_id, idempotency_key, input_hash, result_json, created_at) VALUES ('member_1', 'key_1', 'hash_1', '{}', -1)",
      );
    } finally {
      db.close();
    }
  });

  test("enforces member credential foreign keys", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      expectConstraint(
        db,
        "INSERT INTO member_credentials(id, member_id, kind, secret_hash, revision, created_at) VALUES ('credential_1', 'missing_member', 'RECOVERY', X'00', 1, 0)",
      );
    } finally {
      db.close();
    }
  });

  test("refuses a database with an unknown newer schema version", () => {
    const db = memoryDatabase();
    try {
      db.exec(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY CHECK(version > 0), applied_at INTEGER NOT NULL CHECK(applied_at >= 0))",
      );
      db.exec("INSERT INTO schema_migrations(version, applied_at) VALUES (2, 0)");
      expect(() => migrate(db)).toThrow("SCHEMA_VERSION_NEWER_THAN_SUPPORTED");
    } finally {
      db.close();
    }
  });
});

test("inImmediateTransaction rolls back all writes when the operation throws", () => {
  const db = memoryDatabase();
  try {
    db.exec("CREATE TABLE values_for_test(value TEXT NOT NULL)");
    expect(() =>
      inImmediateTransaction(db, () => {
        db.exec("INSERT INTO values_for_test(value) VALUES ('uncommitted')");
        throw new Error("OPERATION_FAILED");
      }),
    ).toThrow("OPERATION_FAILED");
    expect(
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM values_for_test").get(),
    ).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});
