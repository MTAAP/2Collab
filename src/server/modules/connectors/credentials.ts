import type { Database } from "bun:sqlite";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";

export type CredentialClass = "PROVIDER" | "MEMBER_OAUTH" | "DEVICE_REFRESH";
export type CredentialOwnerKind = "CONNECTOR" | "MEMBER" | "DEVICE";
export type CredentialAssociatedData = Readonly<{
  rowId: string;
  credentialClass: CredentialClass;
  ownerKind: CredentialOwnerKind;
  ownerId: string;
  connectorId: string;
  credentialOwnerId: string;
  keyVersion: number;
  revision: number;
}>;
export type SealedCredential = Readonly<{
  keyId: string;
  keyVersion: number;
  algorithm: "AES_256_GCM" | "XCHACHA20_POLY1305";
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
}>;

export interface CredentialCryptoPort {
  seal(cleartext: Uint8Array, associatedData: CredentialAssociatedData): Promise<SealedCredential>;
  open(sealed: SealedCredential, associatedData: CredentialAssociatedData): Promise<Uint8Array>;
}

type CredentialStoreDependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
  crypto: CredentialCryptoPort;
}>;

type PutCredential = Readonly<{
  credentialClass: CredentialClass;
  ownerKind: CredentialOwnerKind;
  ownerId: string;
  connectorId: string;
  credentialOwnerId: string;
  expectedRevision: number;
  keyVersion: number;
  cleartext: Uint8Array;
}>;

type StoredRow = Readonly<{
  id: string;
  credential_class: CredentialClass;
  owner_kind: CredentialOwnerKind;
  owner_id: string;
  connector_id: string;
  credential_owner_id: string;
  key_id: string;
  key_version: number;
  algorithm: SealedCredential["algorithm"];
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  auth_tag: Uint8Array;
  revision: number;
  revoked_at: number | null;
}>;

function error(
  code: string,
  message: string,
  retry: "NEVER" | "SAME_INPUT" = "NEVER",
): Result<never> {
  return { ok: false, error: { code, message, retry } };
}

function validOwnerId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

export function createEncryptedCredentialStore(dependencies: CredentialStoreDependencies) {
  const rowFor = (
    input: Pick<
      PutCredential,
      "credentialClass" | "ownerKind" | "ownerId" | "connectorId" | "credentialOwnerId"
    >,
  ) =>
    dependencies.database
      .query<StoredRow, [CredentialClass, CredentialOwnerKind, string, string, string]>(
        `SELECT * FROM encrypted_credentials
         WHERE credential_class = ? AND owner_kind = ? AND owner_id = ?
           AND connector_id = ? AND credential_owner_id = ?`,
      )
      .get(
        input.credentialClass,
        input.ownerKind,
        input.ownerId,
        input.connectorId,
        input.credentialOwnerId,
      );

  const legalOwner = (input: Pick<PutCredential, "credentialClass" | "ownerKind">) =>
    (input.credentialClass === "PROVIDER" && input.ownerKind === "CONNECTOR") ||
    (input.credentialClass === "MEMBER_OAUTH" && input.ownerKind === "MEMBER") ||
    (input.credentialClass === "DEVICE_REFRESH" && input.ownerKind === "DEVICE");

  const ownerCollision = (input: PutCredential) =>
    dependencies.database
      .query<
        { owner_kind: CredentialOwnerKind; owner_id: string },
        [CredentialClass, string, string]
      >(
        `SELECT owner_kind, owner_id FROM encrypted_credentials
         WHERE credential_class = ? AND connector_id = ? AND credential_owner_id = ?`,
      )
      .get(input.credentialClass, input.connectorId, input.credentialOwnerId);

  return {
    async put(input: PutCredential): Promise<Result<Readonly<{ id: string; revision: number }>>> {
      if (
        !legalOwner(input) ||
        !validOwnerId(input.ownerId) ||
        !validOwnerId(input.connectorId) ||
        !validOwnerId(input.credentialOwnerId) ||
        input.expectedRevision < 0 ||
        input.keyVersion < 1 ||
        input.cleartext.length < 1 ||
        input.cleartext.length > 32_768
      ) {
        return error("CREDENTIAL_INPUT_INVALID", "Credential input is invalid.");
      }
      const collision = ownerCollision(input);
      if (
        collision &&
        (collision.owner_kind !== input.ownerKind || collision.owner_id !== input.ownerId)
      )
        return error("CREDENTIAL_NOT_FOUND", "Credential was not found.");
      const snapshot = rowFor(input);
      const currentRevision = snapshot?.revision ?? 0;
      if (snapshot && snapshot.revoked_at !== null)
        return error("CREDENTIAL_REVOKED", "Credential is revoked.");
      if (currentRevision !== input.expectedRevision)
        return error("CREDENTIAL_REVISION_STALE", "Credential revision is stale.", "SAME_INPUT");
      const rowId = snapshot?.id ?? dependencies.id("credential");
      const nextRevision = currentRevision + 1;
      const associatedData: CredentialAssociatedData = {
        rowId,
        credentialClass: input.credentialClass,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
        connectorId: input.connectorId,
        credentialOwnerId: input.credentialOwnerId,
        keyVersion: input.keyVersion,
        revision: nextRevision,
      };
      let sealed: SealedCredential;
      try {
        sealed = await dependencies.crypto.seal(input.cleartext, associatedData);
      } catch {
        return error("CREDENTIAL_CRYPTO_FAILED", "Credential encryption failed.");
      }
      if (
        sealed.keyVersion !== input.keyVersion ||
        sealed.keyId.length < 1 ||
        sealed.keyId.length > 128 ||
        sealed.nonce.length < 12 ||
        sealed.nonce.length > 24 ||
        sealed.ciphertext.length < 1 ||
        sealed.ciphertext.length > 65_536 ||
        sealed.authTag.length < 16 ||
        sealed.authTag.length > 32
      ) {
        return error("CREDENTIAL_CRYPTO_FAILED", "Credential encryption failed.");
      }
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const current = rowFor(input);
          if (
            (current?.revision ?? 0) !== currentRevision ||
            current?.revoked_at !== snapshot?.revoked_at
          )
            return error(
              "CREDENTIAL_REVISION_STALE",
              "Credential revision is stale.",
              "SAME_INPUT",
            );
          const now = dependencies.clock();
          dependencies.database
            .query<
              void,
              [
                string,
                CredentialClass,
                CredentialOwnerKind,
                string,
                string,
                string,
                string,
                number,
                SealedCredential["algorithm"],
                Uint8Array,
                Uint8Array,
                Uint8Array,
                number,
                number,
                number,
              ]
            >(
              `INSERT INTO encrypted_credentials(
                 id, credential_class, owner_kind, owner_id, connector_id, credential_owner_id,
                 key_id, key_version, algorithm,
                 nonce, ciphertext, auth_tag, revision, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(credential_class, connector_id, credential_owner_id) DO UPDATE SET
                 key_id = excluded.key_id, key_version = excluded.key_version,
                 algorithm = excluded.algorithm, nonce = excluded.nonce,
                 ciphertext = excluded.ciphertext, auth_tag = excluded.auth_tag,
                 revision = excluded.revision, updated_at = excluded.updated_at`,
            )
            .run(
              rowId,
              input.credentialClass,
              input.ownerKind,
              input.ownerId,
              input.connectorId,
              input.credentialOwnerId,
              sealed.keyId,
              sealed.keyVersion,
              sealed.algorithm,
              sealed.nonce,
              sealed.ciphertext,
              sealed.authTag,
              nextRevision,
              now,
              now,
            );
          return { ok: true, value: { id: rowId, revision: nextRevision } };
        });
      } catch {
        return error("CREDENTIAL_STORAGE_FAILED", "Credential storage failed.");
      }
    },

    async get(
      input: Pick<
        PutCredential,
        "credentialClass" | "ownerKind" | "ownerId" | "connectorId" | "credentialOwnerId"
      >,
    ): Promise<Result<Readonly<{ cleartext: Uint8Array; revision: number }>>> {
      if (
        !legalOwner(input) ||
        !validOwnerId(input.ownerId) ||
        !validOwnerId(input.connectorId) ||
        !validOwnerId(input.credentialOwnerId)
      )
        return error("CREDENTIAL_INPUT_INVALID", "Credential input is invalid.");
      const row = rowFor(input);
      if (!row || row.revoked_at !== null)
        return error("CREDENTIAL_NOT_FOUND", "Credential was not found.");
      const associatedData: CredentialAssociatedData = {
        rowId: row.id,
        credentialClass: row.credential_class,
        ownerKind: row.owner_kind,
        ownerId: row.owner_id,
        connectorId: row.connector_id,
        credentialOwnerId: row.credential_owner_id,
        keyVersion: row.key_version,
        revision: row.revision,
      };
      try {
        const cleartext = await dependencies.crypto.open(
          {
            keyId: row.key_id,
            keyVersion: row.key_version,
            algorithm: row.algorithm,
            nonce: row.nonce,
            ciphertext: row.ciphertext,
            authTag: row.auth_tag,
          },
          associatedData,
        );
        if (cleartext.length > 32_768)
          return error("CREDENTIAL_CRYPTO_FAILED", "Credential decryption failed.");
        const current = rowFor(input);
        if (!current || current.revoked_at !== null || current.revision !== row.revision)
          return error("CREDENTIAL_REVISION_STALE", "Credential revision is stale.", "SAME_INPUT");
        return { ok: true, value: { cleartext, revision: row.revision } };
      } catch {
        return error("CREDENTIAL_CRYPTO_FAILED", "Credential decryption failed.");
      }
    },
  };
}
