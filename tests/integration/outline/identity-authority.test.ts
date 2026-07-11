import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import { createOutlineIdentityResolver } from "../../../src/server/modules/connectors/outline-credentials.ts";

function fixture() {
  const database = new Database(":memory:", { strict: true });
  migrate(database);
  database.exec(`
    INSERT INTO deployments(id,singleton,team_id,revision,created_at) VALUES('d',1,'t',1,0);
    INSERT INTO members(id,display_name,role,status,authority_epoch,revision,created_at)
      VALUES('m','M','MEMBER','ACTIVE',1,1,0);
    INSERT INTO connector_epochs(connector_id,epoch,review_state,revision)
      VALUES('outline',1,'READY',1);
    INSERT INTO encrypted_credentials(id,credential_class,owner_kind,owner_id,connector_id,credential_owner_id,key_id,key_version,algorithm,nonce,ciphertext,auth_tag,revision,created_at,updated_at)
      VALUES('bot','PROVIDER','CONNECTOR','outline','outline','bot','k',1,'AES_256_GCM',zeroblob(12),X'01',zeroblob(16),1,0,0),
            ('member-token','MEMBER_OAUTH','MEMBER','m','outline','m','k',1,'AES_256_GCM',zeroblob(12),X'02',zeroblob(16),1,0,0);
    INSERT INTO outline_connections(connector_id,origin,workspace_id,bot_provider_user_id,bot_credential_id,oauth_client_id,oauth_metadata_digest,revision,created_at,updated_at)
      VALUES('outline','https://outline.test','w','bot-user','bot','client','${"a".repeat(64)}',1,0,0);
    INSERT INTO outline_member_oauth_grants(id,connector_id,member_id,outline_user_id,credential_id,granted_scope_digest,access_expires_at,refresh_status,credential_revision,revision,created_at,updated_at)
      VALUES('g','outline','m','member-user','member-token','${"b".repeat(64)}',2000,'READY',1,1,0,0);
  `);
  return database;
}

test("identity resolution denies inactive members, expired or revoked credentials, and non-ready connector authority", () => {
  const database = fixture();
  try {
    const resolver = createOutlineIdentityResolver(database, { clock: () => 1000 });
    expect(
      resolver.resolve({ operation: "HUMAN_WRITE", connectorId: "outline", memberId: "m" }).ok,
    ).toBe(true);
    database.exec("UPDATE members SET status='REVOKED'");
    expect(
      resolver.resolve({ operation: "HUMAN_WRITE", connectorId: "outline", memberId: "m" }).ok,
    ).toBe(false);
    database.exec(
      "UPDATE members SET status='ACTIVE'; UPDATE encrypted_credentials SET revoked_at=1000 WHERE id='bot'",
    );
    expect(resolver.resolve({ operation: "READ", connectorId: "outline" }).ok).toBe(false);
    database.exec(
      "UPDATE encrypted_credentials SET revoked_at=NULL WHERE id='bot'; UPDATE connector_epochs SET review_state='REVIEW_REQUIRED'",
    );
    expect(resolver.resolve({ operation: "READ", connectorId: "outline" }).ok).toBe(false);
    database.exec(
      "UPDATE connector_epochs SET review_state='READY'; UPDATE outline_member_oauth_grants SET access_expires_at=1000",
    );
    expect(
      resolver.resolve({ operation: "HUMAN_WRITE", connectorId: "outline", memberId: "m" }).ok,
    ).toBe(false);
  } finally {
    database.close();
  }
});
