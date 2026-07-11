import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../migrate.ts";

export function verifyFoundationSchema(db: Database): void {
  expect(
    db
      .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
      .all(),
  ).toEqual(expect.arrayContaining([{ version: 1 }]));
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
      "auth_proxy_replays",
      "authority_revocation_outbox",
      "connector_idempotency",
      "connector_operation_authorizations",
      "connector_operation_intents",
      "connector_projections",
      "connector_scope_operations",
      "connector_scope_references",
      "connector_scopes",
      "connector_epochs",
      "deployments",
      "device_access_tokens",
      "device_authorization_codes",
      "device_credential_families",
      "dpop_replays",
      "encrypted_credentials",
      "idempotency_results",
      "invitation_exchange_sessions",
      "invitations",
      "member_credentials",
      "members",
      "host_recovery_codes",
      "oidc_transactions",
      "passkey_credential_transports",
      "passkey_credentials",
      "projects",
      "recovery_code_sets",
      "recovery_codes",
      "schema_migrations",
      "sessions",
      "source_reconciliation_idempotency",
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
      .query<{ name: string }, []>("PRAGMA table_info(webauthn_challenges)")
      .all()
      .map((row) => row.name),
  ).toContain("passkey_credential_id");
  expect(
    db
      .query<{ name: string }, []>("PRAGMA table_info(sessions)")
      .all()
      .map((row) => row.name),
  ).toContain("proof_hash");
  expect(
    db
      .query<{ name: string }, []>("PRAGMA table_info(sessions)")
      .all()
      .map((row) => row.name),
  ).toEqual(
    expect.arrayContaining([
      "absolute_expires_at",
      "csrf_hash",
      "idle_expires_at",
      "member_authority_epoch",
    ]),
  );
  expect(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'one_active_recovery_code_set_per_member'",
      )
      .get(),
  ).toEqual({ name: "one_active_recovery_code_set_per_member" });
  for (const index of [
    "connector_operation_intents_recovery",
    "one_active_device_family",
    "one_active_host_recovery_per_owner",
    "sessions_active_member",
  ]) {
    expect(
      db
        .query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get(index),
    ).toEqual({ name: index });
  }
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
