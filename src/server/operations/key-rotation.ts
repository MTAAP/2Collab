import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes as secureRandomBytes } from "node:crypto";
import type { Result } from "../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../db/transaction.ts";
import {
  type CredentialAssociatedData,
  type CredentialClass,
  type CredentialCryptoPort,
  type CredentialOwnerKind,
  createEncryptedCredentialStore,
  type SealedCredential,
} from "../modules/connectors/credentials.ts";

const CLASSES = ["PROVIDER", "MEMBER_OAUTH", "DEVICE_REFRESH"] as const;
const encoder = new TextEncoder();

function failure(
  code: string,
  message: string,
  retry: "NEVER" | "SAME_INPUT" = "NEVER",
): Result<never> {
  return { ok: false, error: { code, message, retry } };
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function canonical(value: Readonly<Record<string, string | number>>): Uint8Array {
  return encoder.encode(
    `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${JSON.stringify(item)}`)
      .join(",")}}`,
  );
}

function seal(
  cleartext: Uint8Array,
  key: Uint8Array,
  aad: Uint8Array,
  random: (length: number) => Uint8Array,
): Readonly<{ nonce: Buffer; ciphertext: Buffer; authTag: Buffer }> {
  const nonce = Buffer.from(random(12));
  if (nonce.length !== 12) throw new Error("RANDOM_SOURCE_INVALID");
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

function openSealed(
  ciphertext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  authTag: Uint8Array,
  aad: Uint8Array,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

type WrappingKeyRow = Readonly<{
  id: string;
  credential_class: CredentialClass;
  key_version: number;
  wrapping_key_id: string;
  nonce: Uint8Array;
  wrapped_key: Uint8Array;
  auth_tag: Uint8Array;
  state: "PENDING" | "ACTIVE" | "RETIRED" | "REVOKED";
}>;

type CredentialRow = Readonly<{
  id: string;
  credential_class: CredentialClass;
  owner_kind: CredentialOwnerKind;
  owner_id: string;
  connector_id: string;
  credential_owner_id: string;
  key_id: string;
  key_version: number;
  algorithm: "AES_256_GCM" | "XCHACHA20_POLY1305";
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  auth_tag: Uint8Array;
  revision: number;
  revoked_at: number | null;
}>;

type ManagerDependencies = Readonly<{
  database: Database;
  masterKey: Uint8Array;
  masterKeyId: string;
  clock: () => number;
  id: (prefix: string) => string;
  randomBytes?: (length: number) => Uint8Array;
  beforeRotationVerification?: () => void;
}>;

export type CredentialKeyManager = ReturnType<typeof createCredentialKeyManager>;

export function createCredentialKeyManager(dependencies: ManagerDependencies) {
  let masterKey = Buffer.from(dependencies.masterKey);
  let masterKeyId = dependencies.masterKeyId;
  const random = dependencies.randomBytes ?? ((length: number) => secureRandomBytes(length));
  if (masterKey.length !== 32 || !validIdentifier(masterKeyId)) {
    throw new Error("MASTER_KEY_INPUT_INVALID");
  }

  const wrappingAad = (credentialClass: CredentialClass, keyVersion: number, keyId: string) =>
    canonical({ credentialClass, keyId, keyVersion, masterKeyId });

  const activeRow = (credentialClass: CredentialClass) =>
    dependencies.database
      .query<WrappingKeyRow, [CredentialClass]>(
        "SELECT * FROM credential_wrapping_keys WHERE credential_class = ? AND state = 'ACTIVE'",
      )
      .get(credentialClass);

  const rowAtVersion = (credentialClass: CredentialClass, version: number) =>
    dependencies.database
      .query<WrappingKeyRow, [CredentialClass, number]>(
        "SELECT * FROM credential_wrapping_keys WHERE credential_class = ? AND key_version = ?",
      )
      .get(credentialClass, version);

  const unwrapRow = (row: WrappingKeyRow): Buffer =>
    openSealed(
      row.wrapped_key,
      masterKey,
      row.nonce,
      row.auth_tag,
      wrappingAad(row.credential_class, row.key_version, row.id),
    );

  const classKeyFor = (credentialClass: CredentialClass, version: number): Buffer => {
    const exact = rowAtVersion(credentialClass, version);
    if (exact) {
      try {
        return unwrapRow(exact);
      } catch {
        // Master rotation retires an old wrapper and installs the same class key under the new
        // master. Credential ciphertext keeps its original AAD/version and remains untouched.
      }
    }
    const active = activeRow(credentialClass);
    if (!active) throw new Error("CREDENTIAL_KEY_UNAVAILABLE");
    return unwrapRow(active);
  };

  const cryptoPort: CredentialCryptoPort = {
    async seal(cleartext, associatedData) {
      const row = activeRow(associatedData.credentialClass);
      if (!row || row.key_version !== associatedData.keyVersion) {
        throw new Error("CREDENTIAL_KEY_VERSION_INVALID");
      }
      const sealed = seal(cleartext, unwrapRow(row), canonical(associatedData), random);
      return {
        keyId: row.id,
        keyVersion: row.key_version,
        algorithm: "AES_256_GCM",
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext,
        authTag: sealed.authTag,
      };
    },
    async open(sealedCredential, associatedData) {
      if (
        sealedCredential.algorithm !== "AES_256_GCM" ||
        sealedCredential.keyVersion !== associatedData.keyVersion
      ) {
        throw new Error("CREDENTIAL_CIPHERTEXT_INVALID");
      }
      return openSealed(
        sealedCredential.ciphertext,
        classKeyFor(associatedData.credentialClass, associatedData.keyVersion),
        sealedCredential.nonce,
        sealedCredential.authTag,
        canonical(associatedData),
      );
    },
  };

  const credentialStore = createEncryptedCredentialStore({
    database: dependencies.database,
    clock: dependencies.clock,
    id: dependencies.id,
    crypto: cryptoPort,
  });

  return {
    database: dependencies.database,
    clock: dependencies.clock,
    id: dependencies.id,
    randomBytes: random,
    cryptoPort,
    activeRow,
    rowAtVersion,
    unwrapRow,
    wrapClassKey(credentialClass: CredentialClass, version: number, id: string, key: Uint8Array) {
      return seal(key, masterKey, wrappingAad(credentialClass, version, id), random);
    },
    replaceMasterKey(next: Uint8Array, nextId: string) {
      masterKey = Buffer.from(next);
      masterKeyId = nextId;
    },
    masterKeyId: () => masterKeyId,
    beforeRotationVerification: dependencies.beforeRotationVerification ?? (() => undefined),

    async initializeClass(
      credentialClass: CredentialClass,
    ): Promise<Result<{ keyVersion: number }>> {
      if (!CLASSES.includes(credentialClass)) {
        return failure("CREDENTIAL_CLASS_INVALID", "Credential class is invalid.");
      }
      const current = activeRow(credentialClass);
      if (current) return { ok: true, value: { keyVersion: current.key_version } };
      const keyId = dependencies.id("class_key");
      if (!validIdentifier(keyId))
        return failure("CREDENTIAL_KEY_INPUT_INVALID", "Credential key input is invalid.");
      const raw = random(32);
      if (raw.length !== 32)
        return failure("CREDENTIAL_KEY_GENERATION_FAILED", "Credential key generation failed.");
      const wrapped = seal(raw, masterKey, wrappingAad(credentialClass, 1, keyId), random);
      try {
        inImmediateTransaction(dependencies.database, () => {
          dependencies.database
            .query<
              void,
              [
                string,
                CredentialClass,
                number,
                string,
                Uint8Array,
                Uint8Array,
                Uint8Array,
                number,
                number,
              ]
            >(
              `INSERT INTO credential_wrapping_keys(
                 id, credential_class, key_version, wrapping_key_id, algorithm,
                 nonce, wrapped_key, auth_tag, state, created_at, activated_at
               ) VALUES (?, ?, ?, ?, 'AES_256_GCM', ?, ?, ?, 'ACTIVE', ?, ?)`,
            )
            .run(
              keyId,
              credentialClass,
              1,
              masterKeyId,
              wrapped.nonce,
              wrapped.ciphertext,
              wrapped.authTag,
              dependencies.clock(),
              dependencies.clock(),
            );
        });
        return { ok: true, value: { keyVersion: 1 } };
      } catch {
        return failure(
          "CREDENTIAL_KEY_STORAGE_FAILED",
          "Credential key storage failed.",
          "SAME_INPUT",
        );
      }
    },

    async sealCredential(
      input: Readonly<{
        credentialClass: CredentialClass;
        ownerKind: CredentialOwnerKind;
        ownerId: string;
        connectorId: string;
        credentialOwnerId: string;
        cleartext: Uint8Array;
        expectedRevision: number;
      }>,
    ) {
      const active = activeRow(input.credentialClass);
      if (!active) return failure("CREDENTIAL_KEY_UNAVAILABLE", "Credential key is unavailable.");
      return credentialStore.put({ ...input, keyVersion: active.key_version });
    },

    async openCredential(id: string): Promise<Result<Uint8Array>> {
      if (!validIdentifier(id)) return failure("CREDENTIAL_NOT_FOUND", "Credential was not found.");
      const row = dependencies.database
        .query<CredentialRow, [string]>("SELECT * FROM encrypted_credentials WHERE id = ?")
        .get(id);
      if (!row || row.revoked_at !== null)
        return failure("CREDENTIAL_NOT_FOUND", "Credential was not found.");
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
      const sealedCredential: SealedCredential = {
        keyId: row.key_id,
        keyVersion: row.key_version,
        algorithm: row.algorithm,
        nonce: row.nonce,
        ciphertext: row.ciphertext,
        authTag: row.auth_tag,
      };
      try {
        return { ok: true, value: await cryptoPort.open(sealedCredential, associatedData) };
      } catch {
        return failure("CREDENTIAL_DECRYPTION_FAILED", "Credential decryption failed.");
      }
    },
  };
}

type RotationRow = Readonly<{
  id: string;
  credential_class: CredentialClass;
  from_key_version: number;
  to_key_version: number;
  state: "PENDING" | "REWRAPPING" | "VERIFYING" | "COMPLETED" | "FAILED";
  last_credential_id: string | null;
  processed_count: number;
  revision: number;
}>;

export async function rotateCredentialClassKey(
  input: Readonly<{
    manager: CredentialKeyManager;
    credentialClass: CredentialClass;
    batchSize?: number;
  }>,
): Promise<Result<Readonly<{ completed: boolean; processed: number; keyVersion: number }>>> {
  const batchSize = input.batchSize ?? 100;
  if (
    !CLASSES.includes(input.credentialClass) ||
    !Number.isInteger(batchSize) ||
    batchSize < 0 ||
    batchSize > 1000
  ) {
    return failure("CREDENTIAL_ROTATION_INPUT_INVALID", "Credential rotation input is invalid.");
  }
  const database = input.manager.database;
  let rotation = database
    .query<RotationRow, [CredentialClass]>(
      `SELECT * FROM credential_key_rotations WHERE credential_class = ?
       AND state IN ('PENDING', 'REWRAPPING', 'VERIFYING') ORDER BY created_at LIMIT 1`,
    )
    .get(input.credentialClass);
  try {
    if (!rotation) {
      const active = input.manager.activeRow(input.credentialClass);
      if (!active) return failure("CREDENTIAL_KEY_UNAVAILABLE", "Credential key is unavailable.");
      const toVersion = active.key_version + 1;
      const keyId = input.manager.id("class_key");
      const rotationId = input.manager.id("key_rotation");
      if (!validIdentifier(keyId) || !validIdentifier(rotationId)) {
        return failure(
          "CREDENTIAL_ROTATION_INPUT_INVALID",
          "Credential rotation input is invalid.",
        );
      }
      const nextKey = input.manager.randomBytes(32);
      const masterKeyId = input.manager.masterKeyId();
      // Use the manager's current class-wrapper primitive by temporarily representing the new
      // class key as a one-use credential-like AES-GCM value under the master key is intentionally
      // unavailable here; the manager owns wrapping internals through this helper closure.
      const wrapped = input.manager.wrapClassKey(input.credentialClass, toVersion, keyId, nextKey);
      const now = input.manager.clock();
      inImmediateTransaction(database, () => {
        database
          .query<
            void,
            [string, CredentialClass, number, string, Uint8Array, Uint8Array, Uint8Array, number]
          >(
            `INSERT INTO credential_wrapping_keys(
               id, credential_class, key_version, wrapping_key_id, algorithm,
               nonce, wrapped_key, auth_tag, state, created_at
             ) VALUES (?, ?, ?, ?, 'AES_256_GCM', ?, ?, ?, 'PENDING', ?)`,
          )
          .run(
            keyId,
            input.credentialClass,
            toVersion,
            masterKeyId,
            wrapped.nonce,
            wrapped.ciphertext,
            wrapped.authTag,
            now,
          );
        database
          .query<void, [string, CredentialClass, number, number, number, number]>(
            `INSERT INTO credential_key_rotations(
               id, credential_class, from_key_version, to_key_version, state,
               processed_count, revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'PENDING', 0, 1, ?, ?)`,
          )
          .run(rotationId, input.credentialClass, active.key_version, toVersion, now, now);
      });
      rotation = database
        .query<RotationRow, [string]>("SELECT * FROM credential_key_rotations WHERE id = ?")
        .get(rotationId);
    }
    if (!rotation) throw new Error("ROTATION_STATE_MISSING");
    const activeRotation = rotation;
    if (batchSize === 0) {
      return {
        ok: true,
        value: {
          completed: false,
          processed: activeRotation.processed_count,
          keyVersion: activeRotation.to_key_version,
        },
      };
    }
    const oldKeyRow = input.manager.rowAtVersion(
      input.credentialClass,
      activeRotation.from_key_version,
    );
    const nextKeyRow = input.manager.rowAtVersion(
      input.credentialClass,
      activeRotation.to_key_version,
    );
    if (!oldKeyRow || !nextKeyRow) throw new Error("ROTATION_KEY_MISSING");
    const oldKey = input.manager.unwrapRow(oldKeyRow);
    const nextKey = input.manager.unwrapRow(nextKeyRow);
    const rows = database
      .query<CredentialRow, [CredentialClass, string, number]>(
        `SELECT * FROM encrypted_credentials WHERE credential_class = ? AND id > ?
         ORDER BY id LIMIT ?`,
      )
      .all(input.credentialClass, activeRotation.last_credential_id ?? "", batchSize);
    for (const row of rows) {
      const oldAssociatedData: CredentialAssociatedData = {
        rowId: row.id,
        credentialClass: row.credential_class,
        ownerKind: row.owner_kind,
        ownerId: row.owner_id,
        connectorId: row.connector_id,
        credentialOwnerId: row.credential_owner_id,
        keyVersion: row.key_version,
        revision: row.revision,
      };
      const cleartext = openSealed(
        row.ciphertext,
        oldKey,
        row.nonce,
        row.auth_tag,
        canonical(oldAssociatedData),
      );
      const nextRevision = row.revision + 1;
      const nextAssociatedData = {
        ...oldAssociatedData,
        keyVersion: activeRotation.to_key_version,
        revision: nextRevision,
      };
      const next = seal(
        cleartext,
        nextKey,
        canonical(nextAssociatedData),
        input.manager.randomBytes,
      );
      inImmediateTransaction(database, () => {
        database
          .query<
            void,
            [string, number, Uint8Array, Uint8Array, Uint8Array, number, number, string]
          >(
            `UPDATE encrypted_credentials SET key_id = ?, key_version = ?, algorithm = 'AES_256_GCM',
               nonce = ?, ciphertext = ?, auth_tag = ?, revision = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            nextKeyRow.id,
            activeRotation.to_key_version,
            next.nonce,
            next.ciphertext,
            next.authTag,
            nextRevision,
            input.manager.clock(),
            row.id,
          );
        database
          .query<void, [string, number, string]>(
            `UPDATE credential_key_rotations SET state = 'REWRAPPING', last_credential_id = ?,
               processed_count = processed_count + 1, revision = revision + 1, updated_at = ? WHERE id = ?`,
          )
          .run(row.id, input.manager.clock(), activeRotation.id);
      });
    }
    const remaining =
      database
        .query<{ count: number }, [CredentialClass, string]>(
          "SELECT count(*) AS count FROM encrypted_credentials WHERE credential_class = ? AND id > ?",
        )
        .get(input.credentialClass, rows.at(-1)?.id ?? activeRotation.last_credential_id ?? "")
        ?.count ?? 0;
    if (remaining > 0) {
      const updated = database
        .query<RotationRow, [string]>("SELECT * FROM credential_key_rotations WHERE id = ?")
        .get(activeRotation.id);
      if (!updated) throw new Error("ROTATION_STATE_MISSING");
      return {
        ok: true,
        value: {
          completed: false,
          processed: updated.processed_count,
          keyVersion: updated.to_key_version,
        },
      };
    }
    input.manager.beforeRotationVerification();
    const allRows = database
      .query<CredentialRow, [CredentialClass]>(
        "SELECT * FROM encrypted_credentials WHERE credential_class = ?",
      )
      .all(input.credentialClass);
    for (const row of allRows) {
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
      openSealed(row.ciphertext, nextKey, row.nonce, row.auth_tag, canonical(associatedData));
    }
    const now = input.manager.clock();
    inImmediateTransaction(database, () => {
      database
        .query(
          "UPDATE credential_wrapping_keys SET state = 'RETIRED', retired_at = ? WHERE credential_class = ? AND key_version = ? AND state = 'ACTIVE'",
        )
        .run(now, input.credentialClass, activeRotation.from_key_version);
      database
        .query(
          "UPDATE credential_wrapping_keys SET state = 'ACTIVE', activated_at = ? WHERE credential_class = ? AND key_version = ? AND state = 'PENDING'",
        )
        .run(now, input.credentialClass, activeRotation.to_key_version);
      database
        .query(
          "UPDATE credential_key_rotations SET state = 'COMPLETED', revision = revision + 1, updated_at = ?, completed_at = ? WHERE id = ?",
        )
        .run(now, now, activeRotation.id);
      database
        .query(
          `INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at) VALUES (?, 'CREDENTIAL_CLASS_KEY_ROTATED', 'HOST', 'CONTAINER', ?, ?, ?)`,
        )
        .run(
          input.manager.id("audit"),
          input.credentialClass,
          JSON.stringify({ keyVersion: activeRotation.to_key_version }),
          now,
        );
    });
    const completed = database
      .query<RotationRow, [string]>("SELECT * FROM credential_key_rotations WHERE id = ?")
      .get(activeRotation.id);
    if (!completed) throw new Error("ROTATION_STATE_MISSING");
    return {
      ok: true,
      value: {
        completed: true,
        processed: completed.processed_count,
        keyVersion: completed.to_key_version,
      },
    };
  } catch {
    return failure("CREDENTIAL_ROTATION_FAILED", "Credential rotation failed.", "SAME_INPUT");
  }
}

export async function rotateMasterWrappingKey(
  input: Readonly<{
    manager: CredentialKeyManager;
    nextMasterKey: Uint8Array;
    nextMasterKeyId: string;
  }>,
): Promise<
  Result<Readonly<{ rewrappedClasses: number; retainedBackupKeyIds: readonly string[] }>>
> {
  if (
    input.nextMasterKey.length !== 32 ||
    !validIdentifier(input.nextMasterKeyId) ||
    input.nextMasterKeyId === input.manager.masterKeyId()
  ) {
    return failure("MASTER_ROTATION_INPUT_INVALID", "Master rotation input is invalid.");
  }
  const database = input.manager.database;
  const inProgress = database
    .query<{ count: number }, []>(
      "SELECT count(*) AS count FROM credential_key_rotations WHERE state IN ('PENDING', 'REWRAPPING', 'VERIFYING')",
    )
    .get()?.count;
  if (inProgress) {
    return failure("MASTER_ROTATION_BUSY", "Credential rotation is in progress.", "SAME_INPUT");
  }
  const active = database
    .query<WrappingKeyRow, []>(
      "SELECT * FROM credential_wrapping_keys WHERE state = 'ACTIVE' ORDER BY credential_class",
    )
    .all();
  const retainedBackupKeyIds = database
    .query<{ key_id: string }, []>(
      "SELECT DISTINCT key_id FROM backup_records WHERE state IN ('VERIFIED', 'RETAINED') ORDER BY key_id",
    )
    .all()
    .map((row) => row.key_id)
    .filter((keyId) => keyId !== input.nextMasterKeyId);
  try {
    const unwrapped = active.map((row) => ({ row, key: input.manager.unwrapRow(row) }));
    const nextRows = unwrapped.map(({ row, key }) => {
      const id = input.manager.id("class_key");
      const version = row.key_version + 1;
      const aad = canonical({
        credentialClass: row.credential_class,
        keyId: id,
        keyVersion: version,
        masterKeyId: input.nextMasterKeyId,
      });
      const wrapped = seal(key, input.nextMasterKey, aad, input.manager.randomBytes);
      openSealed(wrapped.ciphertext, input.nextMasterKey, wrapped.nonce, wrapped.authTag, aad);
      return { id, version, row, wrapped };
    });
    const now = input.manager.clock();
    inImmediateTransaction(database, () => {
      for (const next of nextRows) {
        database
          .query(
            "UPDATE credential_wrapping_keys SET state = 'RETIRED', retired_at = ? WHERE id = ? AND state = 'ACTIVE'",
          )
          .run(now, next.row.id);
        database
          .query(
            `INSERT INTO credential_wrapping_keys(id, credential_class, key_version, wrapping_key_id, algorithm, nonce, wrapped_key, auth_tag, state, created_at, activated_at) VALUES (?, ?, ?, ?, 'AES_256_GCM', ?, ?, ?, 'ACTIVE', ?, ?)`,
          )
          .run(
            next.id,
            next.row.credential_class,
            next.version,
            input.nextMasterKeyId,
            next.wrapped.nonce,
            next.wrapped.ciphertext,
            next.wrapped.authTag,
            now,
            now,
          );
      }
      const installed = database
        .query<WrappingKeyRow, []>(
          "SELECT * FROM credential_wrapping_keys WHERE state = 'ACTIVE' ORDER BY credential_class",
        )
        .all();
      for (const row of installed) {
        openSealed(
          row.wrapped_key,
          input.nextMasterKey,
          row.nonce,
          row.auth_tag,
          canonical({
            credentialClass: row.credential_class,
            keyId: row.id,
            keyVersion: row.key_version,
            masterKeyId: input.nextMasterKeyId,
          }),
        );
      }
      database
        .query(
          `INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at) VALUES (?, 'MASTER_WRAPPING_KEY_ROTATED', 'HOST', 'CONTAINER', ?, ?, ?)`,
        )
        .run(
          input.manager.id("audit"),
          input.nextMasterKeyId,
          JSON.stringify({
            rewrappedClasses: nextRows.length,
            retainedBackupKeyCount: retainedBackupKeyIds.length,
          }),
          now,
        );
    });
    input.manager.replaceMasterKey(input.nextMasterKey, input.nextMasterKeyId);
    return { ok: true, value: { rewrappedClasses: nextRows.length, retainedBackupKeyIds } };
  } catch {
    return failure("MASTER_ROTATION_FAILED", "Master rotation failed.", "SAME_INPUT");
  }
}
