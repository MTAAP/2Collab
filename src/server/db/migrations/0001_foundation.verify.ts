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
      .query<{ name: string }, []>("PRAGMA table_info(passkey_credentials)")
      .all()
      .map((row) => row.name),
  ).toEqual(
    expect.arrayContaining([
      "credential_id",
      "public_key",
      "opaque_user_id",
      "signature_counter",
      "backup_eligible",
      "backup_state",
      "device_type",
      "name",
      "created_at",
      "last_used_at",
      "revoked_at",
    ]),
  );
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
