import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createSqliteOutlineOAuthTransactionStore } from "../../../src/server/adapters/outline/oauth-transaction-store.ts";
import { migrate } from "../../../src/server/db/migrate.ts";
import outlineMigration from "../../../src/server/db/migrations/0010_outline.sql" with {
  type: "text",
};

test("SQLite OAuth transactions consume once and recheck member, session, connector epoch, and encrypted verifier", async () => {
  const database = new Database(":memory:", { strict: true });
  try {
    migrate(database);
    database.exec("INSERT INTO schema_migrations(version,applied_at)VALUES(7,0),(8,0),(9,0)");
    database.exec(outlineMigration);
    database.exec(`
      INSERT INTO deployments(id,singleton,team_id,revision,created_at) VALUES('d',1,'t',1,0);
      INSERT INTO members(id,display_name,role,status,authority_epoch,revision,created_at) VALUES('m','M','MEMBER','ACTIVE',1,1,0);
      INSERT INTO sessions(id,member_id,proof_hash,kind,expires_at,idle_expires_at,csrf_hash,absolute_expires_at,member_authority_epoch,revision,created_at)
        VALUES('s','m',zeroblob(32),'BROWSER',2000000,2000000,zeroblob(32),2000000,1,1,0);
      INSERT INTO connector_epochs(connector_id,epoch,review_state,revision) VALUES('outline',1,'READY',1);
      INSERT INTO encrypted_credentials(id,credential_class,owner_kind,owner_id,connector_id,credential_owner_id,key_id,key_version,algorithm,nonce,ciphertext,auth_tag,revision,created_at,updated_at)
        VALUES('bot','PROVIDER','CONNECTOR','outline','outline','bot','k',1,'AES_256_GCM',zeroblob(12),X'01',zeroblob(16),1,0,0),
              ('verifier','MEMBER_OAUTH','MEMBER','m','outline','oauth_tx','k',1,'AES_256_GCM',zeroblob(12),X'02',zeroblob(16),1,0,0);
      INSERT INTO outline_connections(connector_id,origin,workspace_id,bot_provider_user_id,bot_credential_id,oauth_client_id,oauth_metadata_digest,revision,created_at,updated_at)
        VALUES('outline','https://outline.test','w','bot-user','bot','client','${"a".repeat(64)}',1,0,0);
    `);
    const store = createSqliteOutlineOAuthTransactionStore({
      database,
      saveVerifier: () => ({ ok: true, value: { credentialId: "verifier" } }),
      loadVerifier: () => ({ ok: true, value: "v".repeat(43) }),
    });
    const transaction = {
      id: "tx",
      connectorId: "outline",
      connectorEpoch: 1,
      memberId: "m",
      sessionId: "s",
      stateHash: "1".repeat(64),
      redirectOriginDigest: "2".repeat(64),
      verifier: "v".repeat(43),
      challenge: "c".repeat(43),
      scopeDigest: "3".repeat(64),
      expiresAt: 700000,
    };
    expect((await store.save(transaction)).ok).toBe(true);
    expect((await store.consume("tx", transaction.stateHash, 100001)).ok).toBe(true);
    expect((await store.consume("tx", transaction.stateHash, 100002)).ok).toBe(false);
  } finally {
    database.close();
  }
});
