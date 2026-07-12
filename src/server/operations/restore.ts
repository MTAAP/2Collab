import { Database } from "bun:sqlite";
import { createHash, randomBytes as secureRandomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Result } from "../../shared/contracts/result.ts";
import type { MigrationCatalog } from "../db/migrate.ts";
import { inImmediateTransaction } from "../db/transaction.ts";
import { authenticateAndDecryptBackup, type BackupManifest } from "./backup.ts";

type RestoreInput = Readonly<{
  backupPath: string;
  offlineSession: OfflineRestoreSession;
  masterKey: Uint8Array;
  migrations: MigrationCatalog;
  clock: () => number;
  id: (prefix: string) => string;
  randomBytes?: (length: number) => Uint8Array;
}>;

export type RestoreResult = Readonly<{
  schemaVersion: number;
  authorityIncarnation: string;
  connectorReview: "REVIEW_REQUIRED";
}>;

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

function canonical(value: Readonly<Record<string, string | number | boolean>>): string {
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${JSON.stringify(item)}`)
    .join(",")}}`;
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeRestrictive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

type ExclusiveLock = Readonly<{ release(): Promise<void> }>;

async function acquireExclusiveDataLock(targetDatabasePath: string): Promise<ExclusiveLock | null> {
  const target = resolve(targetDatabasePath);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, ".2collab-restore.lock");
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.sync();
    return {
      async release() {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true });
        await syncDirectory(directory);
      },
    };
  } catch {
    return null;
  }
}

const offlineSessions = new WeakSet<object>();

export type OfflineRestoreSession = Readonly<{
  targetDatabasePath: string;
  active(): boolean;
  beforePromotion(): void | Promise<void>;
  release(): Promise<void>;
}>;

export type OfflineRestoreAuthority = Readonly<{
  acquire(targetDatabasePath: string): Promise<Result<OfflineRestoreSession>>;
}>;

/**
 * Issues a one-use, module-branded capability only after the exclusive data-directory lock is held.
 * Listener composition receives no such capability; the offline command root is its sole consumer.
 */
export function createOfflineRestoreAuthority(
  dependencies?: Readonly<{
    beforePromotion?: () => void | Promise<void>;
  }>,
): OfflineRestoreAuthority {
  return {
    async acquire(targetDatabasePath) {
      const lock = await acquireExclusiveDataLock(targetDatabasePath).catch(() => null);
      if (!lock) return failure("RESTORE_LOCKED", "Restore target is locked.", "SAME_INPUT");
      let active = true;
      const session: OfflineRestoreSession = {
        targetDatabasePath: resolve(targetDatabasePath),
        active: () => active,
        beforePromotion: dependencies?.beforePromotion ?? (() => undefined),
        async release() {
          if (!active) return;
          active = false;
          offlineSessions.delete(session);
          await lock.release();
        },
      };
      offlineSessions.add(session);
      return { ok: true, value: session };
    },
  };
}

export const offlineRestoreAuthority = createOfflineRestoreAuthority();

function manifestMatchesCatalog(manifest: BackupManifest, migrations: MigrationCatalog): boolean {
  return (
    migrations.supportsRestoreFrom(manifest.schemaVersion) &&
    migrations.digestForVersion(manifest.schemaVersion) === manifest.migrationDigest
  );
}

function insertBackupRecord(database: Database, manifest: BackupManifest): void {
  const exists = database
    .query<{ count: number }, [string]>("SELECT count(*) AS count FROM backup_records WHERE id = ?")
    .get(manifest.backupId)?.count;
  if (exists) return;
  database
    .query<
      void,
      [
        string,
        string,
        number,
        string,
        string,
        string,
        number,
        string,
        string,
        string,
        number,
        number,
        string,
        number,
        string,
        number,
        number,
      ]
    >(
      `INSERT INTO backup_records(
         id, format, manifest_version, deployment_fingerprint, source_authority_incarnation,
         product_version, schema_version, migration_digest, algorithm, key_id, chunk_bytes,
         plaintext_bytes, plaintext_sha256, ciphertext_bytes, ciphertext_sha256,
         state, created_at, verified_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?, ?)`,
    )
    .run(
      manifest.backupId,
      manifest.format,
      manifest.manifestVersion,
      manifest.deploymentFingerprint,
      manifest.sourceAuthorityIncarnation,
      manifest.productVersion,
      manifest.schemaVersion,
      manifest.migrationDigest,
      manifest.algorithm,
      manifest.keyId,
      manifest.chunkBytes,
      manifest.plaintextBytes,
      manifest.plaintextSha256,
      manifest.ciphertextBytes,
      manifest.ciphertextSha256,
      manifest.createdAt,
      manifest.createdAt,
    );
}

function invalidateAuthority(
  database: Database,
  input: Readonly<{
    manifest: BackupManifest;
    restoreId: string;
    authorityIncarnation: string;
    targetSchemaVersion: number;
    stagedDigest: string;
    now: number;
    auditId: string;
  }>,
): void {
  inImmediateTransaction(database, () => {
    const hasTable = (name: string) =>
      database
        .query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        )
        .get(name) !== null;
    insertBackupRecord(database, input.manifest);
    database
      .query<void, [string, string, string, number, number, string, number, number]>(
        `INSERT INTO restore_operations(
           id, backup_id, target_authority_incarnation, state, source_schema_version,
           target_schema_version, staged_database_digest, revision, created_at, updated_at
         ) VALUES (?, ?, ?, 'INVALIDATING', ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        input.restoreId,
        input.manifest.backupId,
        input.authorityIncarnation,
        input.manifest.schemaVersion,
        input.targetSchemaVersion,
        input.stagedDigest,
        input.now,
        input.now,
      );

    database
      .query("UPDATE members SET authority_epoch = authority_epoch + 1, revision = revision + 1")
      .run();
    if (hasTable("auth_sessions")) database.query("DELETE FROM auth_sessions").run();
    if (hasTable("auth_verifications")) database.query("DELETE FROM auth_verifications").run();
    if (hasTable("auth_email_registration_tickets"))
      database.query("DELETE FROM auth_email_registration_tickets").run();
    if (hasTable("auth_member_links")) {
      database
        .query(
          `UPDATE auth_member_links
           SET authority_epoch_snapshot = (
             SELECT members.authority_epoch FROM members
             WHERE members.id = auth_member_links.member_id
           )
           WHERE revoked_at IS NULL`,
        )
        .run();
    }
    database
      .query("UPDATE sessions SET revoked_at = coalesce(revoked_at, ?) WHERE revoked_at IS NULL")
      .run(input.now);
    database
      .query(
        "UPDATE webauthn_challenges SET revoked_at = coalesce(revoked_at, ?) WHERE revoked_at IS NULL",
      )
      .run(input.now);
    database
      .query(
        "UPDATE invitations SET revoked_at = coalesce(revoked_at, ?) WHERE revoked_at IS NULL AND consumed_at IS NULL",
      )
      .run(input.now);
    database
      .query(
        "UPDATE invitation_exchange_sessions SET revoked_at = coalesce(revoked_at, ?) WHERE revoked_at IS NULL AND consumed_at IS NULL",
      )
      .run(input.now);
    database
      .query(
        "UPDATE host_recovery_codes SET revoked_at = coalesce(revoked_at, ?) WHERE revoked_at IS NULL AND consumed_at IS NULL",
      )
      .run(input.now);
    database
      .query(
        "UPDATE device_authorization_codes SET state = 'EXPIRED', revision = revision + 1 WHERE state IN ('PENDING', 'APPROVED')",
      )
      .run();
    database
      .query(
        "UPDATE device_credential_families SET revoked_at = coalesce(revoked_at, ?), revision = revision + 1 WHERE revoked_at IS NULL",
      )
      .run(input.now);
    database
      .query(
        "UPDATE device_access_tokens SET revoked_at = coalesce(revoked_at, ?), revision = revision + 1 WHERE revoked_at IS NULL",
      )
      .run(input.now);
    database
      .query(
        "UPDATE runner_pairings SET state = 'REVOKED', revoked_at = coalesce(revoked_at, ?), revision = revision + 1 WHERE state != 'REVOKED'",
      )
      .run(input.now);
    database
      .query(
        "UPDATE runner_credentials SET revoked_at = coalesce(revoked_at, ?), revision = revision + 1 WHERE revoked_at IS NULL",
      )
      .run(input.now);
    database
      .query("UPDATE runners SET runner_epoch = runner_epoch + 1, revision = revision + 1")
      .run();
    database
      .query(
        "UPDATE connector_epochs SET epoch = epoch + 1, review_state = CASE WHEN review_state = 'REVOKED' THEN 'REVOKED' ELSE 'REVIEW_REQUIRED' END, revision = revision + 1",
      )
      .run();
    database
      .query(
        "UPDATE connector_operation_authorizations SET state = 'REVOKED' WHERE state = 'RESERVED'",
      )
      .run();
    database
      .query(
        "UPDATE connector_operation_intents SET state = 'REQUIRES_REAUTHORIZATION', updated_at = ? WHERE state IN ('PENDING', 'PROVIDER_CONFIRMED')",
      )
      .run(input.now);
    if (hasTable("outline_member_oauth_grants")) {
      database
        .query(
          `UPDATE encrypted_credentials SET revoked_at=coalesce(revoked_at,?),revision=revision+1,updated_at=?
         WHERE id IN (SELECT credential_id FROM outline_member_oauth_grants
                      UNION SELECT bot_credential_id FROM outline_connections
                      UNION SELECT oauth_client_secret_credential_id FROM outline_connections WHERE oauth_client_secret_credential_id IS NOT NULL)`,
        )
        .run(input.now, input.now);
      database
        .query(
          "UPDATE outline_member_oauth_grants SET refresh_status='REVOKED',revoked_at=coalesce(revoked_at,?),revision=revision+1,updated_at=?",
        )
        .run(input.now, input.now);
      database
        .query(
          "UPDATE outline_oauth_transactions SET revoked_at=coalesce(revoked_at,?),revision=revision+1 WHERE consumed_at IS NULL",
        )
        .run(input.now);
    }
    if (hasTable("document_write_grants")) {
      database
        .query(
          "UPDATE document_write_grants SET revoked_at=coalesce(revoked_at,?),revocation_cause='RESTORE',grant_revision=grant_revision+1",
        )
        .run(input.now);
      database
        .query(
          "UPDATE additional_document_requests SET revoked_at=coalesce(revoked_at,?),revocation_cause='RESTORE',request_revision=request_revision+1",
        )
        .run(input.now);
    }
    if (hasTable("document_proposals")) {
      database
        .query(
          "UPDATE document_proposals SET revoked_at=coalesce(revoked_at,?),revocation_cause='RESTORE'",
        )
        .run(input.now);
      database
        .query(
          "UPDATE external_working_documents SET revoked_at=coalesce(revoked_at,?),revocation_cause='RESTORE',lifecycle_revision=lifecycle_revision+1",
        )
        .run(input.now);
    }
    database
      .query(
        "UPDATE dispatch_permits SET state = 'REVOKED', revoked_at = coalesce(revoked_at, ?), revision = revision + 1 WHERE state = 'ISSUED'",
      )
      .run(input.now);
    database
      .query(
        "UPDATE authority_sessions SET state = 'REVOKED', revoked_at = coalesce(revoked_at, ?), revision = revision + 1 WHERE state = 'ACTIVE'",
      )
      .run(input.now);
    database
      .query(
        "UPDATE mutation_leases SET state = 'REVOKED', revoked_at = coalesce(revoked_at, ?), revision = revision + 1 WHERE state = 'ACTIVE'",
      )
      .run(input.now);
    database
      .query(
        "UPDATE operation_authorizations SET state = 'REVOKED', revoked_at = coalesce(revoked_at, ?), revision = revision + 1 WHERE state = 'ISSUED'",
      )
      .run(input.now);
    database
      .query(
        "UPDATE work_item_mutation_guards SET state = 'REVOKED', revoked_at = coalesce(revoked_at, ?), revision = revision + 1 WHERE state = 'HELD'",
      )
      .run(input.now);
    database
      .query(
        "UPDATE runner_dispatch_outbox SET status = 'FAILED', last_error_code = 'RESTORED_AUTHORITY_INVALID' WHERE status IN ('PENDING', 'DISPATCHED')",
      )
      .run();
    database
      .query(
        "UPDATE authority_termination_intents SET state = 'FAILED', last_error_code = 'RESTORED_AUTHORITY_INVALID', revision = revision + 1 WHERE state IN ('PENDING', 'DISPATCHED')",
      )
      .run();

    const deployment = database
      .query<{ id: string }, []>("SELECT id FROM deployments WHERE singleton = 1")
      .get();
    if (!deployment) throw new Error("DEPLOYMENT_SINGLETON_MISSING");
    database
      .query<void, [string, string, number, string]>(
        `UPDATE deployment_authority_state
         SET authority_incarnation = ?, restore_state = 'READY', restore_operation_id = ?,
             revision = revision + 1, updated_at = ?
         WHERE deployment_id = ? AND singleton = 1`,
      )
      .run(input.authorityIncarnation, input.restoreId, input.now, deployment.id);
    database
      .query<void, [number, number, string]>(
        `UPDATE restore_operations SET state = 'COMPLETED', revision = revision + 1,
           updated_at = ?, completed_at = ? WHERE id = ?`,
      )
      .run(input.now, input.now, input.restoreId);
    database
      .query<void, [string, string, string, number]>(
        `INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at)
         VALUES (?, 'BACKUP_RESTORED', 'HOST', 'CONTAINER', ?, ?, ?)`,
      )
      .run(
        input.auditId,
        input.manifest.backupId,
        canonical({
          connectorState: "REVIEW_REQUIRED",
          sourceSchemaVersion: input.manifest.schemaVersion,
          targetSchemaVersion: input.targetSchemaVersion,
        }),
        input.now,
      );
  });
}

export async function restoreBackup(input: RestoreInput): Promise<Result<RestoreResult>> {
  if (
    input.masterKey.length !== 32 ||
    !offlineSessions.has(input.offlineSession) ||
    !input.offlineSession.active() ||
    basename(input.offlineSession.targetDatabasePath).length < 1 ||
    resolve(input.backupPath) === resolve(input.offlineSession.targetDatabasePath)
  ) {
    return failure("RESTORE_INPUT_INVALID", "Restore input is invalid.");
  }
  const target = resolve(input.offlineSession.targetDatabasePath);
  const directory = dirname(target);
  const staging = join(directory, `.${basename(target)}.${crypto.randomUUID()}.staging`);
  const marker = join(directory, ".2collab-restore-incomplete");
  try {
    const verified = await authenticateAndDecryptBackup(input.backupPath, input.masterKey);
    if (!verified.ok) return verified;
    if (!manifestMatchesCatalog(verified.value.manifest, input.migrations)) {
      return failure("BACKUP_SCHEMA_MISMATCH", "Backup schema is incompatible.");
    }
    try {
      await writeRestrictive(staging, verified.value.databaseBytes);
      let stagedDatabase: Database | undefined;
      try {
        stagedDatabase = new Database(staging, { strict: true });
        try {
          input.migrations.verifyClaimedSchema(
            stagedDatabase,
            verified.value.manifest.schemaVersion,
          );
        } catch {
          throw new Error("BACKUP_SCHEMA_MISMATCH");
        }
        input.migrations.migrateAndVerify(stagedDatabase);
        const now = input.clock();
        const restoreId = input.id("restore");
        const auditId = input.id("audit");
        const authorityIncarnation = Buffer.from(
          (input.randomBytes ?? ((length: number) => secureRandomBytes(length)))(32),
        ).toString("hex");
        if (
          !Number.isSafeInteger(now) ||
          now < 0 ||
          !validIdentifier(restoreId) ||
          !validIdentifier(auditId) ||
          !/^[a-f0-9]{64}$/.test(authorityIncarnation) ||
          authorityIncarnation === verified.value.manifest.sourceAuthorityIncarnation
        ) {
          throw new Error("RESTORE_AUTHORITY_INVALID");
        }
        invalidateAuthority(stagedDatabase, {
          manifest: verified.value.manifest,
          restoreId,
          authorityIncarnation,
          targetSchemaVersion: input.migrations.currentVersion,
          stagedDigest: createHash("sha256").update(stagedDatabase.serialize()).digest("hex"),
          now,
          auditId,
        });
        input.migrations.verifyClaimedSchema(stagedDatabase, input.migrations.currentVersion);
        const integrity = stagedDatabase
          .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
          .get();
        const foreignKeys = stagedDatabase
          .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
          .all();
        if (integrity?.integrity_check !== "ok" || foreignKeys.length !== 0) {
          throw new Error("RESTORE_INTEGRITY_INVALID");
        }
        stagedDatabase.close();
        stagedDatabase = undefined;
        await syncFile(staging);
        await input.offlineSession.beforePromotion();
        await writeRestrictive(marker, new TextEncoder().encode(`${restoreId}\n`));
        await syncDirectory(directory);
        await rename(staging, target);
        await syncDirectory(directory);
        await rm(marker, { force: true });
        await syncDirectory(directory);
        return {
          ok: true,
          value: {
            schemaVersion: input.migrations.currentVersion,
            authorityIncarnation,
            connectorReview: "REVIEW_REQUIRED",
          },
        };
      } finally {
        stagedDatabase?.close();
      }
    } catch (cause) {
      await rm(staging, { force: true });
      await rm(marker, { force: true });
      if (cause instanceof Error && cause.message === "BACKUP_SCHEMA_MISMATCH")
        return failure("BACKUP_SCHEMA_MISMATCH", "Backup schema is incompatible.");
      return failure("RESTORE_STAGING_FAILED", "Restore staging failed.", "SAME_INPUT");
    }
  } finally {
    await rm(staging, { force: true }).catch(() => undefined);
    await input.offlineSession.release().catch(() => undefined);
  }
}

export async function assertNoIncompleteRestore(dataDirectory: string): Promise<Result<true>> {
  try {
    await readFile(join(resolve(dataDirectory), ".2collab-restore-incomplete"));
    return failure("RESTORE_INCOMPLETE", "An incomplete restore requires operator review.");
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: true };
    return failure("RESTORE_STATE_UNAVAILABLE", "Restore state is unavailable.", "SAME_INPUT");
  }
}
