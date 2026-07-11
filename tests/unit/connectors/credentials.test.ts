import { expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import { openDatabase } from "../../../src/server/db/connection.ts";
import {
  createEncryptedCredentialStore,
  type CredentialAssociatedData,
  type CredentialCryptoPort,
} from "../../../src/server/modules/connectors/credentials.ts";

test("credential encryption binds connector and credential-owner row identity into AAD", async () => {
  const database = openDatabase(":memory:");
  migrate(database);
  const associatedData: CredentialAssociatedData[] = [];
  let sequence = 0;
  const crypto: CredentialCryptoPort = {
    async seal(cleartext, aad) {
      associatedData.push(aad);
      return {
        keyId: "key_1",
        keyVersion: aad.keyVersion,
        algorithm: "AES_256_GCM",
        nonce: Uint8Array.from({ length: 12 }, () => 1),
        ciphertext: cleartext,
        authTag: Uint8Array.from({ length: 16 }, () => 2),
      };
    },
    async open(sealed, aad) {
      associatedData.push(aad);
      return sealed.ciphertext;
    },
  };
  const store = createEncryptedCredentialStore({
    database,
    clock: () => 1_000,
    id: () => `credential_${++sequence}`,
    crypto,
  });
  try {
    const put = await store.put({
      credentialClass: "MEMBER_OAUTH",
      ownerKind: "MEMBER",
      ownerId: "member_1",
      connectorId: "connector_outline_1",
      credentialOwnerId: "grant_1",
      expectedRevision: 0,
      keyVersion: 1,
      cleartext: new TextEncoder().encode("secret"),
    });
    expect(put.ok).toBe(true);
    expect(associatedData[0]).toMatchObject({
      connectorId: "connector_outline_1",
      credentialOwnerId: "grant_1",
      ownerId: "member_1",
    });
    const secondWorkspace = await store.put({
      credentialClass: "MEMBER_OAUTH",
      ownerKind: "MEMBER",
      ownerId: "member_1",
      connectorId: "connector_outline_2",
      credentialOwnerId: "grant_2",
      expectedRevision: 0,
      keyVersion: 1,
      cleartext: new TextEncoder().encode("other-secret"),
    });
    expect(secondWorkspace.ok).toBe(true);
    expect(
      database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM encrypted_credentials")
        .get(),
    ).toEqual({ count: 2 });
  } finally {
    database.close();
  }
});
