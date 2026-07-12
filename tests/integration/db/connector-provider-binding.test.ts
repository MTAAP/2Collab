import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate, migrationCatalog } from "../../../src/server/db/migrate.ts";

test("binds every connector identifier to exactly one provider", () => {
  const database = new Database(":memory:", { strict: true });
  try {
    migrate(database);
    database.exec(`
      INSERT INTO connector_epochs(connector_id,epoch,review_state,revision)
      VALUES('shared_1',1,'READY',1);
      INSERT INTO connector_provider_bindings(connector_id,provider,bound_at)
      VALUES('shared_1','OUTLINE',0);
    `);
    expect(() =>
      database.exec(`INSERT INTO github_installations(
        connector_id,app_id,installation_id,account_id,account_node_id,account_login,
        private_key_credential_id,webhook_secret_credential_id,revision,created_at,updated_at
      ) VALUES('shared_1','1','1','1','node','login','missing_a','missing_b',1,0,0)`),
    ).toThrow("CONNECTOR_PROVIDER_COLLISION");
    expect(() =>
      database.exec(
        "UPDATE connector_provider_bindings SET provider='GITHUB' WHERE connector_id='shared_1'",
      ),
    ).toThrow("CONNECTOR_PROVIDER_BINDING_IMMUTABLE");
    expect(() => migrationCatalog.verifyClaimedSchema(database, 18)).not.toThrow();
  } finally {
    database.close();
  }
});

test("does not claim support for unsafe legacy schema-v1 restores", () => {
  expect(migrationCatalog.supportsRestoreFrom(1)).toBe(false);
  expect(migrationCatalog.supportsRestoreFrom(2)).toBe(true);
});
