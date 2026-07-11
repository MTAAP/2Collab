import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerCommandDispatcher } from "../../src/server/command.ts";
import { migrate, migrationCatalog } from "../../src/server/db/migrate.ts";
import {
  createAuthenticatedBackup,
  enforceBackupRetention,
  readDeploymentMasterKeyFile,
  readUnauthenticatedBackupManifest,
} from "../../src/server/operations/backup.ts";
import {
  createCredentialKeyManager,
  rotateCredentialClassKey,
  rotateMasterWrappingKey,
} from "../../src/server/operations/key-rotation.ts";
import {
  createOfflineRestoreAuthority,
  offlineRestoreAuthority,
  restoreBackup,
} from "../../src/server/operations/restore.ts";
import { readServerEnvironment } from "../../src/shared/environment.ts";

const roots: string[] = [];
const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const wrongKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const digest = "a".repeat(64);

function seedReplayableAuthority(database: Database) {
  database.exec(`
    INSERT INTO projects(id, team_id, name, base_branch, revision, created_at)
      VALUES ('project_1', 'team_1', 'Project', 'main', 1, 100);
    INSERT INTO runner_mapping_versions(runner_id, project_id, revision, local_mapping_id, created_at)
      VALUES ('runner_1', 'project_1', 1, 'mapping_1', 100);
    INSERT INTO safe_profile_versions(
      runner_id, profile_id, version, display_name, adapter, supports_native, supports_orca,
      supports_headless, supports_interactive, risk_summary, fingerprint, created_at
    ) VALUES ('runner_1', 'profile_1', 1, 'Safe', 'CODEX', 1, 0, 1, 0, 'Safe profile', '${digest}', 100);
    INSERT INTO coordination_records(id, project_id, title, revision, created_at, updated_at)
      VALUES ('record_1', 'project_1', 'Record', 1, 100, 100);
    INSERT INTO agent_runs(
      id, coordination_record_id, project_id, state, goal, repository_id, repository_mode,
      repository_assurance, base_origin, base_commit, base_branch, intended_branch,
      worktree_identity, effective_configuration_id, effective_configuration_version,
      effective_configuration_digest, dispatcher_kind, dispatcher_id, revision, created_at
    ) VALUES ('run_1', 'record_1', 'project_1', 'QUEUED', 'Goal', 'repository_1', 'MUTATING',
      'ADVISORY', 'EXACT', '${"b".repeat(40)}', 'main', 'run/1', 'worktree_1',
      'configuration_1', 1, '${digest}', 'MEMBER', 'owner_1', 1, 100);
    INSERT INTO execution_attempts(
      id, run_id, project_id, ordinal, runner_id, runner_epoch, mapping_revision,
      profile_version_id, profile_version, profile_fingerprint, host, interaction,
      state, revision, created_at
    ) VALUES ('attempt_1', 'run_1', 'project_1', 1, 'runner_1', 11, 1,
      'profile_1', 1, '${digest}', 'NATIVE', 'HEADLESS', 'PENDING', 1, 100);
    INSERT INTO authority_snapshots(
      id, attempt_id, run_id, project_id, project_revision, actor_kind, actor_id,
      runner_id, runner_owner_member_id, runner_epoch, runner_policy_revision,
      mapping_revision, profile_version_id, profile_version, profile_fingerprint,
      authorization_source, security_policy_version, security_digest, repository_id,
      repository_mode, repository_assurance, base_commit, base_branch, intended_branch,
      effective_configuration_id, effective_configuration_version, effective_configuration_digest,
      permit_seconds, authority_session_seconds, authority_renewal_seconds,
      mutation_disconnect_grace_seconds, snapshot_digest, created_at
    ) VALUES ('snapshot_1', 'attempt_1', 'run_1', 'project_1', 1, 'MEMBER', 'owner_1',
      'runner_1', 'owner_1', 11, 1, 1, 'profile_1', 1, '${digest}', 'OWNER', 1,
      '${digest}', 'repository_1', 'MUTATING', 'ADVISORY', '${"b".repeat(40)}', 'main',
      'run/1', 'configuration_1', 1, '${digest}', 30, 30, 10, 10, '${"c".repeat(64)}', 100);
    INSERT INTO dispatch_permits(
      id, attempt_id, authority_snapshot_id, claims_hash, state, revision, issued_at, expires_at
    ) VALUES ('permit_1', 'attempt_1', 'snapshot_1', '${"d".repeat(64)}', 'ISSUED', 1, 100, 500);
    INSERT INTO work_item_mutation_guards(
      id, coordination_record_id, run_id, fence, state, revision, reserved_at
    ) VALUES ('guard_1', 'record_1', 'run_1', 1, 'HELD', 1, 100);
    INSERT INTO authority_sessions(
      id, attempt_id, runner_id, runner_epoch, connection_id, fence, repository_mode,
      repository_assurance, connector_epochs_digest, state, revision, issued_at, expires_at
    ) VALUES ('authority_session_1', 'attempt_1', 'runner_1', 11, 'connection_1', 1,
      'MUTATING', 'ADVISORY', '${digest}', 'ACTIVE', 1, 100, 500);
    INSERT INTO mutation_leases(
      id, session_id, run_id, attempt_id, mutation_guard_id, fence, state, revision,
      issued_at, expires_at, disconnect_grace_expires_at
    ) VALUES ('lease_1', 'authority_session_1', 'run_1', 'attempt_1', 'guard_1', 1,
      'ACTIVE', 1, 100, 500, 510);
    INSERT INTO operation_authorizations(
      id, session_id, session_fence, mutation_lease_fence, operation_kind,
      operation_digest, state, revision, issued_at, expires_at
    ) VALUES ('operation_1', 'authority_session_1', 1, 1, 'MUTATE_REPOSITORY',
      '${"e".repeat(64)}', 'ISSUED', 1, 100, 500);
    INSERT INTO webauthn_challenges(
      id, purpose, challenge_hash, member_id, rp_id, expected_origin, revision, created_at, expires_at
    ) VALUES ('challenge_1', 'PASSKEY_REGISTRATION', randomblob(32), 'owner_1',
      'localhost', 'https://localhost', 1, 100, 500);
    INSERT INTO runner_pairings(
      id, pairing_secret_hash, device_member_id, device_member_authority_epoch,
      device_family_id, device_id, device_key_thumbprint, state, revision, created_at, expires_at
    ) VALUES ('pairing_1', randomblob(32), 'owner_1', 3, 'family_1', 'device_1',
      'thumbprint_1', 'PENDING', 1, 100, 700);
    INSERT INTO device_authorization_codes(
      id, device_code_hash, device_id, sender_key_thumbprint, state, revision, created_at, expires_at
    ) VALUES ('device_code_1', randomblob(32), 'device_1', 'thumbprint_1', 'PENDING', 1, 100, 700);
    INSERT INTO device_credential_families(
      id, member_id, device_id, sender_key_thumbprint, current_refresh_hash,
      member_authority_epoch, revision, created_at, idle_expires_at, absolute_expires_at
    ) VALUES ('device_family_1', 'owner_1', 'device_1', 'thumbprint_1', randomblob(32),
      3, 1, 100, 700, 900);
    INSERT INTO device_access_tokens(
      id, family_id, access_hash, sender_key_thumbprint, revision, created_at, expires_at
    ) VALUES ('access_1', 'device_family_1', randomblob(32), 'thumbprint_1', 1, 100, 700);
    INSERT INTO connector_scopes(id, project_id, connector_id, connector_epoch, revision, created_at)
      VALUES ('scope_1', 'project_1', 'github_1', 7, 1, 100);
    INSERT INTO connector_operation_authorizations(
      id, proof_hash, project_id, connector_id, connector_epoch, scope_revision,
      reference, operation, action_digest, actor_kind, actor_id, state, created_at, expires_at
    ) VALUES ('connector_auth_1', randomblob(32), 'project_1', 'github_1', 7, 1,
      'issue_1', 'UPDATE_ISSUE', '${digest}', 'MEMBER', 'owner_1', 'RESERVED', 100, 500);
    INSERT INTO connector_operation_intents(
      id, actor_id, actor_kind, operation, idempotency_key, input_hash, action_marker,
      actor_binding_digest, project_id, connector_id, connector_epoch, scope_revision,
      reference, precondition_kind, action_digest, state, attempt_count, created_at, updated_at
    ) VALUES ('intent_1', 'owner_1', 'MEMBER', 'UPDATE_ISSUE', 'idem_1', '${digest}',
      'marker_1', '${digest}', 'project_1', 'github_1', 7, 1, 'issue_1', 'ABSENT',
      '${digest}', 'PENDING', 0, 100, 100);
  `);
}

async function fixture() {
  const root = join(tmpdir(), `2collab-operations-${crypto.randomUUID()}`);
  roots.push(root);
  const dataDir = join(root, "data");
  const backupDir = join(root, "backups");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const databasePath = join(dataDir, "collab.sqlite");
  const database = new Database(databasePath, { strict: true, create: true });
  migrate(database);
  database.exec(`
    INSERT INTO deployments(id, singleton, team_id, revision, created_at)
      VALUES ('deployment_1', 1, 'team_1', 1, 100);
    INSERT INTO deployment_authority_state(
      deployment_id, singleton, authority_incarnation, restore_state, revision, created_at, updated_at
    ) VALUES ('deployment_1', 1, '${"1".repeat(64)}', 'READY', 1, 100, 100);
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
      VALUES ('owner_1', 'Owner', 'OWNER', 'ACTIVE', 3, 1, 100);
    INSERT INTO sessions(
      id, member_id, proof_hash, kind, expires_at, csrf_hash,
      member_authority_epoch, revision, created_at
    ) VALUES ('session_1', 'owner_1', zeroblob(32), 'BROWSER', 999999,
      zeroblob(32), 3, 1, 100);
    INSERT INTO connector_epochs(connector_id, epoch, review_state, revision)
      VALUES ('github_1', 7, 'READY', 1);
    INSERT INTO runners(
      id, owner_member_id, runner_epoch, policy_revision, security_digest, revision, created_at
    ) VALUES ('runner_1', 'owner_1', 11, 1, '${digest}', 1, 100);
    INSERT INTO runner_credentials(
      id, runner_id, credential_hash, key_thumbprint, runner_epoch,
      member_authority_epoch, revision, created_at
    ) VALUES ('runner_credential_1', 'runner_1', randomblob(32), 'thumbprint_1', 11, 3, 1, 100);
  `);
  return { root, dataDir, backupDir, databasePath, database };
}

async function offlineSession(targetDatabasePath: string) {
  const session = await offlineRestoreAuthority.acquire(targetDatabasePath);
  if (!session.ok) throw new Error(session.error.code);
  return session.value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("authenticated backup and isolated restore", () => {
  test("requires a restrictive master-key file outside data and backup volumes", async () => {
    const f = await fixture();
    const missing = await readDeploymentMasterKeyFile({
      secretFile: undefined,
      dataDirectory: f.dataDir,
      backupDirectory: f.backupDir,
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "MASTER_KEY_UNAVAILABLE" } });
    const nested = join(f.dataDir, "master.key");
    await writeFile(nested, key, { mode: 0o600 });
    const invalidLocation = await readDeploymentMasterKeyFile({
      secretFile: nested,
      dataDirectory: f.dataDir,
      backupDirectory: f.backupDir,
    });
    expect(invalidLocation).toMatchObject({
      ok: false,
      error: { code: "MASTER_KEY_LOCATION_INVALID" },
    });
    const valid = join(f.root, "secrets", "master.key");
    await mkdir(join(f.root, "secrets"), { mode: 0o700 });
    await writeFile(valid, key, { mode: 0o600 });
    const loaded = await readDeploymentMasterKeyFile({
      secretFile: valid,
      dataDirectory: f.dataDir,
      backupDirectory: f.backupDir,
    });
    expect(loaded.ok && loaded.value.bytes).toEqual(key);
    const linked = join(f.root, "linked.key");
    await symlink(valid, linked);
    expect(
      await readDeploymentMasterKeyFile({
        secretFile: linked,
        dataDirectory: f.dataDir,
        backupDirectory: f.backupDir,
      }),
    ).toMatchObject({ ok: false, error: { code: "MASTER_KEY_FILE_INVALID" } });
    f.database.close();
  });

  test("creates a canonical chunked authenticated backup and independently verifies it", async () => {
    const f = await fixture();
    const result = await createAuthenticatedBackup({
      database: f.database,
      destinationDirectory: f.backupDir,
      masterKey: key,
      keyId: "master_1",
      productVersion: "0.1.0",
      migrations: migrationCatalog,
      clock: () => 200,
      id: () => "backup_1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest).toMatchObject({
      format: "2COLLAB_BACKUP_V1",
      algorithm: "AES_256_GCM_CHUNKED_V1",
      schemaVersion: 15,
      keyId: "master_1",
    });
    expect(result.value.manifest.chunkCount).toBeGreaterThan(0);
    expect((await stat(result.value.path)).mode & 0o077).toBe(0);
    expect((await readUnauthenticatedBackupManifest(result.value.path)).ok).toBe(true);
    expect(
      f.database.query<{ state: string }, []>("SELECT state FROM backup_records").get(),
    ).toEqual({ state: "VERIFIED" });
    f.database.close();
  });

  test("fails closed on nonce reuse and removes restrictive temporary artifacts", async () => {
    const f = await fixture();
    const result = await createAuthenticatedBackup({
      database: f.database,
      destinationDirectory: f.backupDir,
      masterKey: key,
      keyId: "master_1",
      productVersion: "0.1.0",
      migrations: migrationCatalog,
      clock: () => 200,
      id: () => "backup_nonce_reuse",
      randomBytes: (length) => new Uint8Array(length),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "BACKUP_CREATION_FAILED" } });
    expect(
      (await readdir(f.backupDir)).filter((name) => name.includes("backup_nonce_reuse")),
    ).toEqual([]);
    expect(
      f.database.query<{ count: number }, []>("SELECT count(*) AS count FROM backup_records").get(),
    ).toEqual({ count: 0 });
    f.database.close();
  });

  test("rejects missing/wrong keys and ciphertext or manifest tampering without promotion", async () => {
    const f = await fixture();
    const backup = await createAuthenticatedBackup({
      database: f.database,
      destinationDirectory: f.backupDir,
      masterKey: key,
      keyId: "master_1",
      productVersion: "0.1.0",
      migrations: migrationCatalog,
      clock: () => 200,
      id: () => "backup_1",
    });
    expect(backup.ok).toBe(true);
    if (!backup.ok) return;
    f.database.close();
    const target = join(f.root, "restored.sqlite");
    const wrong = await restoreBackup({
      backupPath: backup.value.path,
      offlineSession: await offlineSession(target),
      masterKey: wrongKey,
      migrations: migrationCatalog,
      clock: () => 300,
      id: () => crypto.randomUUID(),
    });
    expect(wrong).toMatchObject({ ok: false, error: { code: "BACKUP_AUTHENTICATION_FAILED" } });
    const bytes = await readFile(backup.value.path);
    const tamperOffset = bytes.length - 20;
    bytes[tamperOffset] = (bytes[tamperOffset] ?? 0) ^ 0xff;
    await writeFile(backup.value.path, bytes, { mode: 0o600 });
    const tampered = await restoreBackup({
      backupPath: backup.value.path,
      offlineSession: await offlineSession(target),
      masterKey: key,
      migrations: migrationCatalog,
      clock: () => 300,
      id: () => crypto.randomUUID(),
    });
    expect(tampered).toMatchObject({ ok: false, error: { code: "BACKUP_INTEGRITY_FAILED" } });
    expect(Bun.file(target).size).toBe(0);
  });

  test("restores only through isolated staging and invalidates restored authority", async () => {
    const f = await fixture();
    seedReplayableAuthority(f.database);
    const backup = await createAuthenticatedBackup({
      database: f.database,
      destinationDirectory: f.backupDir,
      masterKey: key,
      keyId: "master_1",
      productVersion: "0.1.0",
      migrations: migrationCatalog,
      clock: () => 200,
      id: () => "backup_1",
    });
    if (!backup.ok) throw new Error(backup.error.code);
    f.database.close();
    const target = join(f.root, "restored.sqlite");
    const restored = await restoreBackup({
      backupPath: backup.value.path,
      offlineSession: await offlineSession(target),
      masterKey: key,
      migrations: migrationCatalog,
      clock: () => 300,
      id: (prefix) => `${prefix}_1`,
    });
    expect(restored.ok).toBe(true);
    const database = new Database(target, { strict: true, readonly: true });
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM sessions WHERE revoked_at IS NULL",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM webauthn_challenges WHERE revoked_at IS NULL",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM runner_pairings WHERE state != 'REVOKED'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM device_credential_families WHERE revoked_at IS NULL",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM device_access_tokens WHERE revoked_at IS NULL",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM runner_credentials WHERE revoked_at IS NULL",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database.query<{ state: string }, []>("SELECT state FROM dispatch_permits").get(),
    ).toEqual({ state: "REVOKED" });
    expect(
      database.query<{ state: string }, []>("SELECT state FROM authority_sessions").get(),
    ).toEqual({ state: "REVOKED" });
    expect(
      database.query<{ state: string }, []>("SELECT state FROM mutation_leases").get(),
    ).toEqual({ state: "REVOKED" });
    expect(
      database.query<{ state: string }, []>("SELECT state FROM operation_authorizations").get(),
    ).toEqual({ state: "REVOKED" });
    expect(
      database
        .query<{ state: string }, []>("SELECT state FROM connector_operation_authorizations")
        .get(),
    ).toEqual({ state: "REVOKED" });
    expect(
      database.query<{ state: string }, []>("SELECT state FROM connector_operation_intents").get(),
    ).toEqual({ state: "REQUIRES_REAUTHORIZATION" });
    expect(
      database.query<{ runner_epoch: number }, []>("SELECT runner_epoch FROM runners").get(),
    ).toEqual({ runner_epoch: 12 });
    expect(
      database
        .query<{ epoch: number; review_state: string }, []>(
          "SELECT epoch, review_state FROM connector_epochs",
        )
        .get(),
    ).toEqual({ epoch: 8, review_state: "REVIEW_REQUIRED" });
    expect(
      database
        .query<{ authority_incarnation: string; restore_state: string }, []>(
          "SELECT authority_incarnation, restore_state FROM deployment_authority_state",
        )
        .get(),
    ).toEqual({
      authority_incarnation: restored.ok ? restored.value.authorityIncarnation : "",
      restore_state: "READY",
    });
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM audit_events WHERE kind = 'BACKUP_RESTORED'",
        )
        .get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  test("schema mismatch and staging failure never replace an existing target", async () => {
    const f = await fixture();
    const backup = await createAuthenticatedBackup({
      database: f.database,
      destinationDirectory: f.backupDir,
      masterKey: key,
      keyId: "master_1",
      productVersion: "0.1.0",
      migrations: migrationCatalog,
      clock: () => 200,
      id: () => "backup_1",
    });
    if (!backup.ok) throw new Error(backup.error.code);
    f.database.close();
    const target = join(f.root, "existing.sqlite");
    await writeFile(target, "ORIGINAL", { mode: 0o600 });
    const incompatible = await restoreBackup({
      backupPath: backup.value.path,
      offlineSession: await offlineSession(target),
      masterKey: key,
      migrations: { ...migrationCatalog, supportsRestoreFrom: () => false },
      clock: () => 300,
      id: () => crypto.randomUUID(),
    });
    expect(incompatible).toMatchObject({ ok: false, error: { code: "BACKUP_SCHEMA_MISMATCH" } });
    expect(await readFile(target, "utf8")).toBe("ORIGINAL");
    const failed = await restoreBackup({
      backupPath: backup.value.path,
      offlineSession: await (async () => {
        const acquired = await createOfflineRestoreAuthority({
          beforePromotion: () => {
            throw new Error("INJECTED");
          },
        }).acquire(target);
        if (!acquired.ok) throw new Error(acquired.error.code);
        return acquired.value;
      })(),
      masterKey: key,
      migrations: migrationCatalog,
      clock: () => 300,
      id: () => crypto.randomUUID(),
    });
    expect(failed).toMatchObject({ ok: false, error: { code: "RESTORE_STAGING_FAILED" } });
    expect(await readFile(target, "utf8")).toBe("ORIGINAL");
  });

  test("authenticated claimed-schema drift is rejected before staging promotion", async () => {
    const f = await fixture();
    f.database.exec("DROP TABLE sessions");
    const laxCatalog = {
      ...migrationCatalog,
      verifyClaimedSchema: () => undefined,
    };
    const backup = await createAuthenticatedBackup({
      database: f.database,
      destinationDirectory: f.backupDir,
      masterKey: key,
      keyId: "master_1",
      productVersion: "0.1.0",
      migrations: laxCatalog,
      clock: () => 200,
      id: () => "backup_drift",
    });
    if (!backup.ok) throw new Error(backup.error.code);
    f.database.close();
    const target = join(f.root, "existing.sqlite");
    await writeFile(target, "ORIGINAL", { mode: 0o600 });
    const result = await restoreBackup({
      backupPath: backup.value.path,
      offlineSession: await offlineSession(target),
      masterKey: key,
      migrations: migrationCatalog,
      clock: () => 300,
      id: () => crypto.randomUUID(),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "BACKUP_SCHEMA_MISMATCH" } });
    expect(await readFile(target, "utf8")).toBe("ORIGINAL");
  });

  test("requires a genuine one-use offline capability and excludes lock contention", async () => {
    const f = await fixture();
    const target = join(f.root, "locked.sqlite");
    const authority = createOfflineRestoreAuthority();
    const first = await authority.acquire(target);
    if (!first.ok) throw new Error(first.error.code);
    const second = await authority.acquire(target);
    expect(second).toMatchObject({ ok: false, error: { code: "RESTORE_LOCKED" } });
    const forged = await restoreBackup({
      backupPath: join(f.root, "missing.backup"),
      offlineSession: {
        targetDatabasePath: target,
        active: () => true,
        beforePromotion: () => undefined,
        release: async () => undefined,
      },
      masterKey: key,
      migrations: migrationCatalog,
      clock: () => 300,
      id: () => crypto.randomUUID(),
    });
    expect(forged).toMatchObject({ ok: false, error: { code: "RESTORE_INPUT_INVALID" } });
    await first.value.release();
    f.database.close();
  });

  test("server command root rejects listener mode and keeps secrets and paths out of results", async () => {
    const f = await fixture();
    const secretsDirectory = join(f.root, "secrets");
    const masterKeyFile = join(secretsDirectory, "master.key");
    await mkdir(secretsDirectory, { mode: 0o700 });
    await writeFile(masterKeyFile, key, { mode: 0o600 });
    const maintenanceEnvironment = readServerEnvironment({
      DATA_DIR: f.dataDir,
      BACKUP_DIR: f.backupDir,
      DEPLOYMENT_MASTER_KEY_FILE: masterKeyFile,
    });
    const maintenance = createServerCommandDispatcher({
      invocationMode: "OFFLINE_OPERATION",
      operationMode: "MAINTENANCE",
      database: f.database,
      environment: maintenanceEnvironment,
      productVersion: "0.1.0",
      migrations: migrationCatalog,
      offlineRestoreAuthority,
      clock: () => 300,
      id: (prefix) => `${prefix}_${crypto.randomUUID()}`,
    });
    const created = await maintenance.execute(["backup", "create"]);
    expect(created).toMatchObject({ ok: true, value: { operation: "BACKUP_CREATE" } });
    expect(JSON.stringify(created)).not.toContain(masterKeyFile);
    expect(JSON.stringify(created)).not.toContain(Buffer.from(key).toString("hex"));
    const environment = readServerEnvironment({
      DATA_DIR: f.dataDir,
      BACKUP_DIR: f.backupDir,
      DEPLOYMENT_MASTER_KEY_FILE: join(f.root, "missing-secret.key"),
    });
    expect(() =>
      createServerCommandDispatcher({
        invocationMode: "LISTENER" as "OFFLINE_OPERATION",
        operationMode: "RESTORE",
        environment,
        productVersion: "0.1.0",
        migrations: migrationCatalog,
        offlineRestoreAuthority,
        clock: () => 300,
        id: () => crypto.randomUUID(),
      }),
    ).toThrow("SERVER_COMMAND_MODE_INVALID");
    const dispatcher = createServerCommandDispatcher({
      invocationMode: "OFFLINE_OPERATION",
      operationMode: "RESTORE",
      environment,
      productVersion: "0.1.0",
      migrations: migrationCatalog,
      offlineRestoreAuthority,
      clock: () => 300,
      id: () => crypto.randomUUID(),
    });
    const result = await dispatcher.execute([
      "restore",
      "apply",
      join(f.root, "backup.2collab-backup"),
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: "MASTER_KEY_UNAVAILABLE" } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(f.root);
    expect(serialized).not.toContain("missing-secret.key");
    expect(serialized).not.toContain(Buffer.from(key).toString("hex"));
    f.database.close();
  });
});

describe("credential and master wrapping-key rotation", () => {
  test("credential-class rotation resumes after process restart and activates only after verification", async () => {
    const f = await fixture();
    let nextId = 0;
    const manager = createCredentialKeyManager({
      database: f.database,
      masterKey: key,
      masterKeyId: "master_1",
      clock: () => 400,
      id: (prefix) => `${prefix}_${++nextId}`,
    });
    expect((await manager.initializeClass("PROVIDER")).ok).toBe(true);
    const inserted = await manager.sealCredential({
      credentialClass: "PROVIDER",
      ownerKind: "CONNECTOR",
      ownerId: "github_1",
      connectorId: "github_1",
      credentialOwnerId: "installation_1",
      cleartext: new TextEncoder().encode("secret"),
      expectedRevision: 0,
    });
    expect(inserted.ok).toBe(true);
    await manager.sealCredential({
      credentialClass: "PROVIDER",
      ownerKind: "CONNECTOR",
      ownerId: "github_1",
      connectorId: "github_1",
      credentialOwnerId: "installation_2",
      cleartext: new TextEncoder().encode("second"),
      expectedRevision: 0,
    });
    const first = await rotateCredentialClassKey({
      manager,
      credentialClass: "PROVIDER",
      batchSize: 1,
    });
    expect(first).toMatchObject({ ok: true, value: { completed: false } });
    const restarted = createCredentialKeyManager({
      database: f.database,
      masterKey: key,
      masterKeyId: "master_1",
      clock: () => 401,
      id: (prefix) => `${prefix}_${++nextId}`,
    });
    const resumed = await rotateCredentialClassKey({
      manager: restarted,
      credentialClass: "PROVIDER",
      batchSize: 10,
    });
    expect(resumed).toMatchObject({ ok: true, value: { completed: true } });
    if (!inserted.ok) throw new Error(inserted.error.code);
    const opened = await restarted.openCredential(inserted.value.id);
    expect(opened.ok && new TextDecoder().decode(opened.value)).toBe("secret");
    f.database.close();
  });

  test("failed rotation verification leaves the prior class key active and can resume", async () => {
    const f = await fixture();
    let nextId = 0;
    const failing = createCredentialKeyManager({
      database: f.database,
      masterKey: key,
      masterKeyId: "master_1",
      clock: () => 400,
      id: (prefix) => `${prefix}_${++nextId}`,
      beforeRotationVerification: () => {
        throw new Error("VERIFY_FAILED");
      },
    });
    await failing.initializeClass("PROVIDER");
    await failing.sealCredential({
      credentialClass: "PROVIDER",
      ownerKind: "CONNECTOR",
      ownerId: "github_1",
      connectorId: "github_1",
      credentialOwnerId: "installation_1",
      cleartext: new TextEncoder().encode("secret"),
      expectedRevision: 0,
    });
    const failed = await rotateCredentialClassKey({
      manager: failing,
      credentialClass: "PROVIDER",
      batchSize: 10,
    });
    expect(failed).toMatchObject({ ok: false, error: { code: "CREDENTIAL_ROTATION_FAILED" } });
    expect(
      f.database
        .query<{ key_version: number }, []>(
          "SELECT key_version FROM credential_wrapping_keys WHERE state = 'ACTIVE'",
        )
        .get(),
    ).toEqual({ key_version: 1 });
    const restarted = createCredentialKeyManager({
      database: f.database,
      masterKey: key,
      masterKeyId: "master_1",
      clock: () => 401,
      id: (prefix) => `${prefix}_${++nextId}`,
    });
    expect(
      await rotateCredentialClassKey({
        manager: restarted,
        credentialClass: "PROVIDER",
        batchSize: 10,
      }),
    ).toMatchObject({ ok: true, value: { completed: true } });
    f.database.close();
  });

  test("master rotation rewraps class keys and preserves retained-backup key accountability", async () => {
    const f = await fixture();
    let nextId = 0;
    const manager = createCredentialKeyManager({
      database: f.database,
      masterKey: key,
      masterKeyId: "master_1",
      clock: () => 400,
      id: (prefix) => `${prefix}_${++nextId}`,
    });
    await manager.initializeClass("PROVIDER");
    const credential = await manager.sealCredential({
      credentialClass: "PROVIDER",
      ownerKind: "CONNECTOR",
      ownerId: "github_1",
      connectorId: "github_1",
      credentialOwnerId: "installation_1",
      cleartext: new TextEncoder().encode("secret"),
      expectedRevision: 0,
    });
    if (!credential.ok) throw new Error(credential.error.code);
    f.database
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
        `INSERT INTO backup_records(id, format, manifest_version, deployment_fingerprint, source_authority_incarnation, product_version, schema_version, migration_digest, algorithm, key_id, chunk_bytes, plaintext_bytes, plaintext_sha256, ciphertext_bytes, ciphertext_sha256, state, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?, ?)`,
      )
      .run(
        "backup_old",
        "2COLLAB_BACKUP_V1",
        1,
        digest,
        "1".repeat(64),
        "0.1.0",
        6,
        digest,
        "AES_256_GCM_CHUNKED_V1",
        "master_1",
        4096,
        1,
        digest,
        1,
        digest,
        400,
        400,
      );
    const rotated = await rotateMasterWrappingKey({
      manager,
      nextMasterKey: wrongKey,
      nextMasterKeyId: "master_2",
    });
    expect(rotated).toMatchObject({ ok: true, value: { retainedBackupKeyIds: ["master_1"] } });
    expect(
      f.database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM audit_events WHERE kind = 'MASTER_WRAPPING_KEY_ROTATED'",
        )
        .get(),
    ).toEqual({ count: 1 });
    const restartedWithNew = createCredentialKeyManager({
      database: f.database,
      masterKey: wrongKey,
      masterKeyId: "master_2",
      clock: () => 401,
      id: (prefix) => `${prefix}_${++nextId}`,
    });
    const reopened = await restartedWithNew.openCredential(credential.value.id);
    expect(reopened.ok && new TextDecoder().decode(reopened.value)).toBe("secret");
    const restartedWithOld = createCredentialKeyManager({
      database: f.database,
      masterKey: key,
      masterKeyId: "master_1",
      clock: () => 401,
      id: (prefix) => `${prefix}_${++nextId}`,
    });
    expect(await restartedWithOld.openCredential(credential.value.id)).toMatchObject({
      ok: false,
      error: { code: "CREDENTIAL_DECRYPTION_FAILED" },
    });
    const retired = f.database
      .query<Parameters<typeof restartedWithOld.unwrapRow>[0], []>(
        "SELECT * FROM credential_wrapping_keys WHERE state = 'RETIRED'",
      )
      .get();
    if (!retired) throw new Error("RETIRED_KEY_MISSING");
    expect(() => restartedWithOld.unwrapRow(retired)).toThrow("CREDENTIAL_KEY_NOT_ACTIVE");
    f.database.close();
  });

  test("retention enforces count, age, and bytes but never deletes the sole verified usable backup", async () => {
    const f = await fixture();
    const old = await createAuthenticatedBackup({
      database: f.database,
      destinationDirectory: f.backupDir,
      masterKey: key,
      keyId: "master_1",
      productVersion: "0.1.0",
      migrations: migrationCatalog,
      clock: () => 100,
      id: (prefix) => (prefix === "backup" ? "old" : `${prefix}_old`),
    });
    const newest = await createAuthenticatedBackup({
      database: f.database,
      destinationDirectory: f.backupDir,
      masterKey: key,
      keyId: "master_1",
      productVersion: "0.1.0",
      migrations: migrationCatalog,
      clock: () => 900,
      id: (prefix) => (prefix === "backup" ? "newest" : `${prefix}_newest`),
    });
    if (!old.ok || !newest.ok) throw new Error("BACKUP_FIXTURE_FAILED");
    f.database.exec(`INSERT INTO backup_records(
      id, format, manifest_version, deployment_fingerprint, source_authority_incarnation,
      product_version, schema_version, migration_digest, algorithm, key_id, chunk_bytes,
      plaintext_bytes, plaintext_sha256, ciphertext_bytes, ciphertext_sha256,
      state, created_at
    ) VALUES ('failed', '2COLLAB_BACKUP_V1', 1, '${digest}', '${"1".repeat(64)}',
      '0.1.0', 6, '${digest}', 'AES_256_GCM_CHUNKED_V1', 'master_1', 4096,
      1, '${digest}', 1, '${digest}', 'FAILED', 50)`);
    const retained = await enforceBackupRetention({
      database: f.database,
      backupDirectory: f.backupDir,
      now: 1000,
      policy: {
        maximumAgeSeconds: 10,
        maximumVerifiedBackups: 1,
        maximumBytes: newest.value.manifest.ciphertextBytes,
        minimumUsableBackups: 1,
      },
      migrations: migrationCatalog,
      masterKeys: new Map([["master_1", key]]),
      id: (prefix) => `${prefix}_${crypto.randomUUID()}`,
    });
    expect(retained).toMatchObject({ ok: true, value: { deleted: 1, retained: 1 } });
    expect(
      f.database
        .query<{ id: string; state: string }, []>(
          "SELECT id, state FROM backup_records ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "failed", state: "FAILED" },
      { id: "newest", state: "VERIFIED" },
      { id: "old", state: "DELETED" },
    ]);
    expect(Bun.file(join(f.backupDir, "newest.2collab-backup")).size).toBeGreaterThan(0);
    f.database.close();
  });

  test("retention rejects a newer missing row and preserves the only authenticated physical backup", async () => {
    const f = await fixture();
    const old = await createAuthenticatedBackup({
      database: f.database,
      destinationDirectory: f.backupDir,
      masterKey: key,
      keyId: "master_1",
      productVersion: "0.1.0",
      migrations: migrationCatalog,
      clock: () => 100,
      id: () => "backup_old",
    });
    const newer = await createAuthenticatedBackup({
      database: f.database,
      destinationDirectory: f.backupDir,
      masterKey: key,
      keyId: "master_1",
      productVersion: "0.1.0",
      migrations: migrationCatalog,
      clock: () => 900,
      id: () => "backup_new",
    });
    if (!old.ok || !newer.ok) throw new Error("BACKUP_FIXTURE_FAILED");
    await rm(newer.value.path);
    const retained = await enforceBackupRetention({
      database: f.database,
      backupDirectory: f.backupDir,
      now: 1000,
      policy: {
        maximumAgeSeconds: 10,
        maximumVerifiedBackups: 1,
        maximumBytes: 10 * 1024 * 1024 * 1024,
        minimumUsableBackups: 1,
      },
      migrations: migrationCatalog,
      masterKeys: new Map([["master_1", key]]),
      id: (prefix) => `${prefix}_${crypto.randomUUID()}`,
    });
    expect(retained).toMatchObject({ ok: true, value: { deleted: 0, retained: 1 } });
    expect(await Bun.file(old.value.path).exists()).toBeTrue();
    expect(
      f.database
        .query<{ id: string; state: string }, []>(
          "SELECT id, state FROM backup_records ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "backup_new", state: "FAILED" },
      { id: "backup_old", state: "VERIFIED" },
    ]);
    expect(
      f.database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM audit_events WHERE kind = 'BACKUP_MARKED_UNUSABLE'",
        )
        .get(),
    ).toEqual({ count: 1 });
    f.database.close();
  });

  test("retention marks a corrupt physical backup unusable before selecting survivors", async () => {
    const f = await fixture();
    const old = await createAuthenticatedBackup({
      database: f.database,
      destinationDirectory: f.backupDir,
      masterKey: key,
      keyId: "master_1",
      productVersion: "0.1.0",
      migrations: migrationCatalog,
      clock: () => 100,
      id: (prefix) => (prefix === "backup" ? "backup_old" : `${prefix}_old`),
    });
    const corrupt = await createAuthenticatedBackup({
      database: f.database,
      destinationDirectory: f.backupDir,
      masterKey: key,
      keyId: "master_1",
      productVersion: "0.1.0",
      migrations: migrationCatalog,
      clock: () => 900,
      id: (prefix) => (prefix === "backup" ? "backup_corrupt" : `${prefix}_corrupt`),
    });
    if (!old.ok || !corrupt.ok) throw new Error("BACKUP_FIXTURE_FAILED");
    const bytes = await readFile(corrupt.value.path);
    const offset = bytes.length - 20;
    bytes[offset] = (bytes[offset] ?? 0) ^ 0xff;
    await writeFile(corrupt.value.path, bytes, { mode: 0o600 });
    const retained = await enforceBackupRetention({
      database: f.database,
      backupDirectory: f.backupDir,
      now: 1000,
      policy: {
        maximumAgeSeconds: 10,
        maximumVerifiedBackups: 1,
        maximumBytes: 10 * 1024 * 1024 * 1024,
        minimumUsableBackups: 1,
      },
      migrations: migrationCatalog,
      masterKeys: new Map([["master_1", key]]),
      id: (prefix) => `${prefix}_${crypto.randomUUID()}`,
    });
    expect(retained).toMatchObject({ ok: true, value: { deleted: 0, retained: 1 } });
    expect(await Bun.file(old.value.path).exists()).toBeTrue();
    expect(
      f.database
        .query<{ state: string }, []>(
          "SELECT state FROM backup_records WHERE id = 'backup_corrupt'",
        )
        .get(),
    ).toEqual({ state: "FAILED" });
    f.database.close();
  });

  test("retention persistence failure never removes a file still marked verified", async () => {
    const f = await fixture();
    const old = await createAuthenticatedBackup({
      database: f.database,
      destinationDirectory: f.backupDir,
      masterKey: key,
      keyId: "master_1",
      productVersion: "0.1.0",
      migrations: migrationCatalog,
      clock: () => 100,
      id: (prefix) => (prefix === "backup" ? "old" : `${prefix}_old`),
    });
    const newest = await createAuthenticatedBackup({
      database: f.database,
      destinationDirectory: f.backupDir,
      masterKey: key,
      keyId: "master_1",
      productVersion: "0.1.0",
      migrations: migrationCatalog,
      clock: () => 900,
      id: (prefix) => (prefix === "backup" ? "newest" : `${prefix}_newest`),
    });
    if (!old.ok || !newest.ok) throw new Error("BACKUP_FIXTURE_FAILED");
    f.database.exec(`
      CREATE TRIGGER fail_retention_audit BEFORE INSERT ON audit_events
      WHEN NEW.kind = 'BACKUP_RETIRED' BEGIN SELECT RAISE(ABORT, 'FAIL'); END;
    `);
    const oldPath = old.value.path;
    const result = await enforceBackupRetention({
      database: f.database,
      backupDirectory: f.backupDir,
      now: 1000,
      policy: {
        maximumAgeSeconds: 10,
        maximumVerifiedBackups: 1,
        maximumBytes: 10,
        minimumUsableBackups: 1,
      },
      migrations: migrationCatalog,
      masterKeys: new Map([["master_1", key]]),
      id: (prefix) => `${prefix}_1`,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "BACKUP_RETENTION_FAILED" } });
    expect(
      f.database
        .query<{ state: string }, []>("SELECT state FROM backup_records WHERE id = 'old'")
        .get(),
    ).toEqual({ state: "VERIFIED" });
    expect(Bun.file(oldPath).size).toBeGreaterThan(0);
    f.database.close();
  });
});
