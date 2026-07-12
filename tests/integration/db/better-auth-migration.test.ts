import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { LATEST_SCHEMA_VERSION, migrate } from "../../../src/server/db/migrate.ts";

describe("Better Auth schema migration", () => {
  test("installs the embedded auth schema and explicitly links existing members", () => {
    const database = new Database(":memory:", { strict: true });
    migrate(database);

    expect(LATEST_SCHEMA_VERSION).toBe(18);
    const tables = new Set(
      database
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    for (const table of [
      "auth_users",
      "auth_sessions",
      "auth_accounts",
      "auth_verifications",
      "auth_passkeys",
      "auth_device_codes",
      "auth_member_links",
      "auth_registration_tickets",
    ]) {
      expect(tables.has(table)).toBe(true);
    }

    database
      .query(
        "INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at) VALUES ('owner_existing', 'Existing Owner', 'OWNER', 'ACTIVE', 3, 1, 100)",
      )
      .run();
    expect(
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM auth_member_links").get()
        ?.count,
    ).toBe(0);
    database.close();
  });

  test("rejects a claimed v18 database missing an auth table", () => {
    const database = new Database(":memory:", { strict: true });
    migrate(database);
    database.exec("DROP TABLE auth_device_codes");
    expect(() => migrate(database)).toThrow("SCHEMA_INTEGRITY_INVALID");
    database.close();
  });
});
