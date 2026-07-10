import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../migrate.ts";

export function verifyFoundationSchema(db: Database): void {
  expect(
    db
      .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
      .all(),
  ).toEqual([{ version: 1 }]);
  expect(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name),
  ).toEqual(
    expect.arrayContaining([
      "audit_events",
      "connector_epochs",
      "deployments",
      "encrypted_credentials",
      "idempotency_results",
      "invitation_exchange_sessions",
      "invitations",
      "member_credentials",
      "members",
      "passkey_credential_transports",
      "passkey_credentials",
      "projects",
      "recovery_code_sets",
      "recovery_codes",
      "schema_migrations",
      "sessions",
      "webauthn_challenges",
    ]),
  );
  expect(
    db
      .query<{ name: string }, []>("PRAGMA table_info(members)")
      .all()
      .map((row) => row.name),
  ).toContain("display_name");
  expect(
    db
      .query<{ name: string; type: string }, []>("PRAGMA table_info(passkey_credentials)")
      .all()
      .map((row) => ({ name: row.name, type: row.type })),
  ).toEqual(
    expect.arrayContaining([
      { name: "credential_id", type: "TEXT" },
      { name: "public_key", type: "BLOB" },
      { name: "opaque_user_id", type: "BLOB" },
    ]),
  );
  expect(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'one_active_recovery_code_set_per_member'",
      )
      .get(),
  ).toEqual({ name: "one_active_recovery_code_set_per_member" });
  expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()).toEqual({
    foreign_keys: 1,
  });
}

test("0001 foundation migration verifies from an empty isolated database", () => {
  const db = new Database(":memory:", { strict: true });
  try {
    migrate(db);
    verifyFoundationSchema(db);
  } finally {
    db.close();
  }
});
