import { Database } from "bun:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes as secureRandomBytes,
} from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Result } from "../../shared/contracts/result.ts";
import type { MigrationCatalog } from "../db/migrate.ts";
import { inImmediateTransaction } from "../db/transaction.ts";

const FORMAT = "2COLLAB_BACKUP_V1" as const;
const ALGORITHM = "AES_256_GCM_CHUNKED_V1" as const;
const MAGIC = Buffer.from("2COLLAB_BACKUP_V1\0", "ascii");
const MANIFEST_VERSION = 1 as const;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024 * 1024;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const BACKUP_INFO = Buffer.from("2COLLAB/BACKUP/PAYLOAD/V1", "utf8");
const MANIFEST_INFO = Buffer.from("2COLLAB/BACKUP/MANIFEST/V1", "utf8");

export type BackupManifest = Readonly<{
  format: typeof FORMAT;
  manifestVersion: typeof MANIFEST_VERSION;
  backupId: string;
  backupFingerprint: string;
  deploymentFingerprint: string;
  sourceAuthorityIncarnation: string;
  productVersion: string;
  schemaVersion: number;
  migrationDigest: string;
  algorithm: typeof ALGORITHM;
  keyId: string;
  chunkBytes: number;
  chunkCount: number;
  plaintextBytes: number;
  plaintextSha256: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
  createdAt: number;
}>;

type BackupDependencies = Readonly<{
  database: Database;
  destinationDirectory: string;
  masterKey: Uint8Array;
  keyId: string;
  productVersion: string;
  migrations: MigrationCatalog;
  clock: () => number;
  id: (prefix: string) => string;
  chunkBytes?: number;
  randomBytes?: (length: number) => Uint8Array;
}>;

export type VerifiedBackup = Readonly<{
  manifest: BackupManifest;
  databaseBytes: Uint8Array;
}>;

export type DeploymentMasterKey = Readonly<{ bytes: Uint8Array; keyId: string }>;

function pathIsWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

/** Reads exactly 32 secret bytes from a restrictive file outside data and backup volumes. */
export async function readDeploymentMasterKeyFile(
  input: Readonly<{
    secretFile: string | undefined;
    dataDirectory: string;
    backupDirectory: string;
  }>,
): Promise<Result<DeploymentMasterKey>> {
  if (!input.secretFile) {
    return failure("MASTER_KEY_UNAVAILABLE", "Deployment master key is unavailable.");
  }
  try {
    const requestedSecret = resolve(input.secretFile);
    const linkMetadata = await lstat(requestedSecret);
    if (linkMetadata.isSymbolicLink()) {
      return failure("MASTER_KEY_FILE_INVALID", "Deployment master key file is invalid.");
    }
    const secret = await realpath(requestedSecret);
    const data = await realpath(resolve(input.dataDirectory));
    const backups = await realpath(resolve(input.backupDirectory));
    if (pathIsWithin(data, secret) || pathIsWithin(backups, secret)) {
      return failure("MASTER_KEY_LOCATION_INVALID", "Deployment master key location is invalid.");
    }
    const handle = await open(secret, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.dev !== linkMetadata.dev ||
        metadata.ino !== linkMetadata.ino ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.size !== 32
      ) {
        return failure("MASTER_KEY_FILE_INVALID", "Deployment master key file is invalid.");
      }
      const bytes = await handle.readFile();
      if (bytes.length !== 32) {
        return failure("MASTER_KEY_FILE_INVALID", "Deployment master key file is invalid.");
      }
      return {
        ok: true,
        value: { bytes, keyId: `key_${sha256(bytes).slice(0, 24)}` },
      };
    } finally {
      await handle.close();
    }
  } catch {
    return failure("MASTER_KEY_UNAVAILABLE", "Deployment master key is unavailable.");
  }
}

const manifestKeys = [
  "format",
  "manifestVersion",
  "backupId",
  "backupFingerprint",
  "deploymentFingerprint",
  "sourceAuthorityIncarnation",
  "productVersion",
  "schemaVersion",
  "migrationDigest",
  "algorithm",
  "keyId",
  "chunkBytes",
  "chunkCount",
  "plaintextBytes",
  "plaintextSha256",
  "ciphertextBytes",
  "ciphertextSha256",
  "createdAt",
] as const;

function failure(
  code: string,
  message: string,
  retry: "NEVER" | "SAME_INPUT" = "NEVER",
): Result<never> {
  return { ok: false, error: { code, message, retry } };
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function validHexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("CANONICAL_NUMBER_INVALID");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") throw new Error("CANONICAL_VALUE_INVALID");
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function encodeManifest(manifest: BackupManifest): Uint8Array {
  return new TextEncoder().encode(canonical(manifest));
}

function parseManifest(bytes: Uint8Array): BackupManifest | null {
  if (bytes.length < 2 || bytes.length > MAX_MANIFEST_BYTES) return null;
  let parsed: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== manifestKeys.length ||
    manifestKeys.some((key) => !Object.hasOwn(record, key)) ||
    canonical(record) !== text ||
    record.format !== FORMAT ||
    record.manifestVersion !== MANIFEST_VERSION ||
    record.algorithm !== ALGORITHM ||
    !validIdentifier(String(record.backupId ?? "")) ||
    !validIdentifier(String(record.keyId ?? "")) ||
    !validHexDigest(record.backupFingerprint) ||
    !validHexDigest(record.deploymentFingerprint) ||
    typeof record.sourceAuthorityIncarnation !== "string" ||
    record.sourceAuthorityIncarnation.length < 32 ||
    record.sourceAuthorityIncarnation.length > 128 ||
    typeof record.productVersion !== "string" ||
    record.productVersion.length < 1 ||
    record.productVersion.length > 64 ||
    !Number.isSafeInteger(record.schemaVersion) ||
    (record.schemaVersion as number) < 1 ||
    !validHexDigest(record.migrationDigest) ||
    !Number.isSafeInteger(record.chunkBytes) ||
    (record.chunkBytes as number) < 4096 ||
    (record.chunkBytes as number) > 16_777_216 ||
    !Number.isSafeInteger(record.chunkCount) ||
    (record.chunkCount as number) < 1 ||
    !Number.isSafeInteger(record.plaintextBytes) ||
    (record.plaintextBytes as number) < 1 ||
    (record.plaintextBytes as number) > MAX_BACKUP_BYTES ||
    !validHexDigest(record.plaintextSha256) ||
    !Number.isSafeInteger(record.ciphertextBytes) ||
    (record.ciphertextBytes as number) < 1 ||
    (record.ciphertextBytes as number) > MAX_BACKUP_BYTES ||
    !validHexDigest(record.ciphertextSha256) ||
    !Number.isSafeInteger(record.createdAt) ||
    (record.createdAt as number) < 0
  ) {
    return null;
  }
  if (
    record.chunkCount !==
    Math.ceil((record.plaintextBytes as number) / (record.chunkBytes as number))
  ) {
    return null;
  }
  return record as BackupManifest;
}

function deriveKey(masterKey: Uint8Array, backupId: string, info: Uint8Array): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterKey, createHash("sha256").update(backupId).digest(), info, 32),
  );
}

function chunkAad(backupId: string, index: number, count: number): Buffer {
  return Buffer.from(`${FORMAT}\0${backupId}\0${index}\0${count}`, "utf8");
}

function encryptChunk(
  cleartext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
): Readonly<{ ciphertext: Buffer; tag: Buffer }> {
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

function decryptChunk(
  ciphertext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  tag: Uint8Array,
  aad: Uint8Array,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: GCM_TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function u32(value: number): Buffer {
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32BE(value);
  return result;
}

function readU32(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return Buffer.from(bytes.buffer, bytes.byteOffset + offset, 4).readUInt32BE(0);
}

function buildCiphertextRecords(
  plaintext: Uint8Array,
  backupId: string,
  chunkBytes: number,
  key: Uint8Array,
  random: (length: number) => Uint8Array,
): Readonly<{ bytes: Buffer; count: number }> {
  const count = Math.ceil(plaintext.length / chunkBytes);
  const records: Buffer[] = [];
  for (let index = 0; index < count; index += 1) {
    const chunk = plaintext.subarray(
      index * chunkBytes,
      Math.min((index + 1) * chunkBytes, plaintext.length),
    );
    const nonce = random(GCM_NONCE_BYTES);
    if (nonce.length !== GCM_NONCE_BYTES) throw new Error("RANDOM_SOURCE_INVALID");
    const sealed = encryptChunk(chunk, key, nonce, chunkAad(backupId, index, count));
    records.push(Buffer.from(nonce), u32(sealed.ciphertext.length), sealed.ciphertext, sealed.tag);
  }
  return { bytes: Buffer.concat(records), count };
}

function makeFile(
  manifestBytes: Uint8Array,
  manifestKey: Uint8Array,
  ciphertextRecords: Uint8Array,
  chunkCount: number,
  random: (length: number) => Uint8Array,
): Buffer {
  const nonce = random(GCM_NONCE_BYTES);
  if (nonce.length !== GCM_NONCE_BYTES) throw new Error("RANDOM_SOURCE_INVALID");
  const authentication = encryptChunk(new Uint8Array(), manifestKey, nonce, manifestBytes);
  return Buffer.concat([
    MAGIC,
    u32(manifestBytes.length),
    Buffer.from(nonce),
    authentication.tag,
    u32(chunkCount),
    Buffer.from(manifestBytes),
    Buffer.from(ciphertextRecords),
  ]);
}

type ParsedFile = Readonly<{
  manifest: BackupManifest;
  manifestBytes: Uint8Array;
  manifestNonce: Uint8Array;
  manifestTag: Uint8Array;
  chunkCount: number;
  ciphertextRecords: Uint8Array;
}>;

function parseFile(bytes: Uint8Array): ParsedFile | null {
  const fixed = MAGIC.length + 4 + GCM_NONCE_BYTES + GCM_TAG_BYTES + 4;
  if (bytes.length < fixed || bytes.length > MAX_BACKUP_BYTES) return null;
  if (!Buffer.from(bytes.subarray(0, MAGIC.length)).equals(MAGIC)) return null;
  const manifestLength = readU32(bytes, MAGIC.length);
  if (manifestLength === null || manifestLength < 2 || manifestLength > MAX_MANIFEST_BYTES)
    return null;
  const nonceOffset = MAGIC.length + 4;
  const tagOffset = nonceOffset + GCM_NONCE_BYTES;
  const countOffset = tagOffset + GCM_TAG_BYTES;
  const chunkCount = readU32(bytes, countOffset);
  const manifestOffset = countOffset + 4;
  const recordsOffset = manifestOffset + manifestLength;
  if (chunkCount === null || chunkCount < 1 || recordsOffset > bytes.length) return null;
  const manifestBytes = bytes.subarray(manifestOffset, recordsOffset);
  const manifest = parseManifest(manifestBytes);
  if (!manifest || manifest.chunkCount !== chunkCount) return null;
  return {
    manifest,
    manifestBytes,
    manifestNonce: bytes.subarray(nonceOffset, tagOffset),
    manifestTag: bytes.subarray(tagOffset, countOffset),
    chunkCount,
    ciphertextRecords: bytes.subarray(recordsOffset),
  };
}

function decryptParsed(parsed: ParsedFile, masterKey: Uint8Array): Result<VerifiedBackup> {
  if (masterKey.length !== 32) {
    return failure("BACKUP_AUTHENTICATION_FAILED", "Backup authentication failed.");
  }
  if (
    parsed.ciphertextRecords.length !== parsed.manifest.ciphertextBytes ||
    sha256(parsed.ciphertextRecords) !== parsed.manifest.ciphertextSha256
  ) {
    return failure("BACKUP_INTEGRITY_FAILED", "Backup integrity verification failed.");
  }
  const manifestKey = deriveKey(masterKey, parsed.manifest.backupId, MANIFEST_INFO);
  try {
    decryptChunk(
      new Uint8Array(),
      manifestKey,
      parsed.manifestNonce,
      parsed.manifestTag,
      parsed.manifestBytes,
    );
  } catch {
    return failure("BACKUP_AUTHENTICATION_FAILED", "Backup authentication failed.");
  }
  const payloadKey = deriveKey(masterKey, parsed.manifest.backupId, BACKUP_INFO);
  const chunks: Buffer[] = [];
  let offset = 0;
  try {
    for (let index = 0; index < parsed.chunkCount; index += 1) {
      if (offset + GCM_NONCE_BYTES + 4 + GCM_TAG_BYTES > parsed.ciphertextRecords.length) {
        return failure("BACKUP_INTEGRITY_FAILED", "Backup integrity verification failed.");
      }
      const nonce = parsed.ciphertextRecords.subarray(offset, offset + GCM_NONCE_BYTES);
      offset += GCM_NONCE_BYTES;
      const length = readU32(parsed.ciphertextRecords, offset);
      offset += 4;
      if (
        length === null ||
        length > parsed.manifest.chunkBytes ||
        offset + length + GCM_TAG_BYTES > parsed.ciphertextRecords.length
      ) {
        return failure("BACKUP_INTEGRITY_FAILED", "Backup integrity verification failed.");
      }
      const ciphertext = parsed.ciphertextRecords.subarray(offset, offset + length);
      offset += length;
      const tag = parsed.ciphertextRecords.subarray(offset, offset + GCM_TAG_BYTES);
      offset += GCM_TAG_BYTES;
      chunks.push(
        decryptChunk(
          ciphertext,
          payloadKey,
          nonce,
          tag,
          chunkAad(parsed.manifest.backupId, index, parsed.chunkCount),
        ),
      );
    }
  } catch {
    return failure("BACKUP_AUTHENTICATION_FAILED", "Backup authentication failed.");
  }
  if (offset !== parsed.ciphertextRecords.length) {
    return failure("BACKUP_INTEGRITY_FAILED", "Backup integrity verification failed.");
  }
  const databaseBytes = Buffer.concat(chunks);
  if (
    databaseBytes.length !== parsed.manifest.plaintextBytes ||
    sha256(databaseBytes) !== parsed.manifest.plaintextSha256
  ) {
    return failure("BACKUP_INTEGRITY_FAILED", "Backup integrity verification failed.");
  }
  return { ok: true, value: { manifest: parsed.manifest, databaseBytes } };
}

/** Parses bounded metadata only. It does not authenticate the manifest or payload. */
export async function readUnauthenticatedBackupManifest(
  path: string,
): Promise<Result<BackupManifest>> {
  try {
    const parsed = parseFile(await readFile(path));
    if (!parsed) return failure("BACKUP_FORMAT_INVALID", "Backup format is invalid.");
    return { ok: true, value: parsed.manifest };
  } catch {
    return failure("BACKUP_UNAVAILABLE", "Backup is unavailable.", "SAME_INPUT");
  }
}

export async function authenticateAndDecryptBackup(
  path: string,
  masterKey: Uint8Array,
): Promise<Result<VerifiedBackup>> {
  try {
    const parsed = parseFile(await readFile(path));
    if (!parsed) return failure("BACKUP_FORMAT_INVALID", "Backup format is invalid.");
    return decryptParsed(parsed, masterKey);
  } catch {
    return failure("BACKUP_UNAVAILABLE", "Backup is unavailable.", "SAME_INPUT");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertPathComponent(value: string): void {
  if (!validIdentifier(value) || basename(value) !== value) throw new Error("BACKUP_ID_INVALID");
}

export async function createAuthenticatedBackup(
  input: BackupDependencies,
): Promise<Result<Readonly<{ path: string; manifest: BackupManifest }>>> {
  const chunkBytes = input.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (
    input.masterKey.length !== 32 ||
    !validIdentifier(input.keyId) ||
    input.productVersion.length < 1 ||
    input.productVersion.length > 64 ||
    !Number.isInteger(chunkBytes) ||
    chunkBytes < 4096 ||
    chunkBytes > 16_777_216
  ) {
    return failure("BACKUP_INPUT_INVALID", "Backup input is invalid.");
  }
  const random = input.randomBytes ?? ((length: number) => secureRandomBytes(length));
  const backupId = input.id("backup");
  try {
    assertPathComponent(backupId);
  } catch {
    return failure("BACKUP_INPUT_INVALID", "Backup input is invalid.");
  }
  const migrationDigest = input.migrations.digestForVersion(input.migrations.currentVersion);
  if (!migrationDigest) return failure("BACKUP_SCHEMA_INVALID", "Backup schema is invalid.");
  const authority = input.database
    .query<{ deployment_id: string; team_id: string; authority_incarnation: string }, []>(
      `SELECT d.id AS deployment_id, d.team_id, a.authority_incarnation
       FROM deployments d JOIN deployment_authority_state a ON a.deployment_id = d.id
       WHERE d.singleton = 1 AND a.singleton = 1 AND a.restore_state = 'READY'`,
    )
    .get();
  if (!authority)
    return failure("BACKUP_AUTHORITY_UNAVAILABLE", "Backup authority is unavailable.");
  let plaintext: Buffer;
  try {
    input.migrations.verifyClaimedSchema(input.database, input.migrations.currentVersion);
    plaintext = input.database.serialize();
  } catch {
    return failure("BACKUP_SNAPSHOT_FAILED", "Backup snapshot failed.", "SAME_INPUT");
  }
  if (plaintext.length < 1 || plaintext.length > MAX_BACKUP_BYTES) {
    return failure("BACKUP_SIZE_INVALID", "Backup size is invalid.");
  }
  let temporaryPath: string | undefined;
  try {
    const seenNonces = new Set<string>();
    const nonceRandom = (length: number): Uint8Array => {
      const bytes = random(length);
      if (length === GCM_NONCE_BYTES) {
        const encoded = Buffer.from(bytes).toString("hex");
        if (seenNonces.has(encoded)) throw new Error("BACKUP_NONCE_REUSED");
        seenNonces.add(encoded);
      }
      return bytes;
    };
    const payloadKey = deriveKey(input.masterKey, backupId, BACKUP_INFO);
    const records = buildCiphertextRecords(
      plaintext,
      backupId,
      chunkBytes,
      payloadKey,
      nonceRandom,
    );
    const createdAt = input.clock();
    const manifest: BackupManifest = {
      format: FORMAT,
      manifestVersion: MANIFEST_VERSION,
      backupId,
      backupFingerprint: Buffer.from(random(32)).toString("hex"),
      deploymentFingerprint: sha256(`${authority.deployment_id}\0${authority.team_id}`),
      sourceAuthorityIncarnation: authority.authority_incarnation,
      productVersion: input.productVersion,
      schemaVersion: input.migrations.currentVersion,
      migrationDigest,
      algorithm: ALGORITHM,
      keyId: input.keyId,
      chunkBytes,
      chunkCount: records.count,
      plaintextBytes: plaintext.length,
      plaintextSha256: sha256(plaintext),
      ciphertextBytes: records.bytes.length,
      ciphertextSha256: sha256(records.bytes),
      createdAt,
    };
    if (
      !validHexDigest(manifest.backupFingerprint) ||
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0
    ) {
      return failure("BACKUP_INPUT_INVALID", "Backup input is invalid.");
    }
    const manifestBytes = encodeManifest(manifest);
    const fileBytes = makeFile(
      manifestBytes,
      deriveKey(input.masterKey, backupId, MANIFEST_INFO),
      records.bytes,
      records.count,
      nonceRandom,
    );
    const directory = resolve(input.destinationDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const finalPath = join(directory, `${backupId}.2collab-backup`);
    temporaryPath = join(directory, `.${backupId}.${crypto.randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(fileBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, finalPath);
    await rm(temporaryPath);
    temporaryPath = undefined;
    await syncDirectory(directory);

    const independentlyVerified = await authenticateAndDecryptBackup(finalPath, input.masterKey);
    if (!independentlyVerified.ok) {
      await rm(finalPath, { force: true });
      return independentlyVerified;
    }
    let verificationDatabase: Database | undefined;
    try {
      verificationDatabase = Database.deserialize(independentlyVerified.value.databaseBytes, {
        readonly: true,
        strict: true,
      });
      input.migrations.verifyClaimedSchema(verificationDatabase, manifest.schemaVersion);
    } catch {
      await rm(finalPath, { force: true });
      return failure("BACKUP_INTEGRITY_FAILED", "Backup integrity verification failed.");
    } finally {
      verificationDatabase?.close();
    }

    try {
      inImmediateTransaction(input.database, () => {
        input.database
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
               id, format, manifest_version, deployment_fingerprint,
               source_authority_incarnation, product_version, schema_version, migration_digest,
               algorithm, key_id, chunk_bytes, plaintext_bytes, plaintext_sha256,
               ciphertext_bytes, ciphertext_sha256, state, created_at, verified_at
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
            createdAt,
            createdAt,
          );
        input.database
          .query<void, [string, string, string, number]>(
            `INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at)
             VALUES (?, 'BACKUP_VERIFIED', 'HOST', 'CONTAINER', ?, ?, ?)`,
          )
          .run(
            input.id("audit"),
            manifest.backupId,
            canonical({ keyId: manifest.keyId, schemaVersion: manifest.schemaVersion }),
            createdAt,
          );
      });
    } catch {
      await rm(finalPath, { force: true });
      return failure("BACKUP_RECORD_FAILED", "Backup recording failed.", "SAME_INPUT");
    }
    return { ok: true, value: { path: finalPath, manifest } };
  } catch {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
    return failure("BACKUP_CREATION_FAILED", "Backup creation failed.", "SAME_INPUT");
  }
}

export type BackupRetentionPolicy = Readonly<{
  maximumAgeSeconds?: number;
  maximumVerifiedBackups?: number;
  maximumBytes?: number;
  minimumUsableBackups?: number;
}>;

type RetentionRow = Readonly<{
  id: string;
  format: string;
  manifest_version: number;
  deployment_fingerprint: string;
  source_authority_incarnation: string;
  product_version: string;
  schema_version: number;
  migration_digest: string;
  algorithm: string;
  key_id: string;
  chunk_bytes: number;
  plaintext_bytes: number;
  plaintext_sha256: string;
  ciphertext_bytes: number;
  ciphertext_sha256: string;
  created_at: number;
}>;

type BackupUsability =
  | Readonly<{ kind: "USABLE" }>
  | Readonly<{ kind: "CORRUPT"; reason: string }>
  | Readonly<{ kind: "UNAVAILABLE" }>;

function manifestMatchesRecord(manifest: BackupManifest, row: RetentionRow): boolean {
  return (
    manifest.backupId === row.id &&
    manifest.format === row.format &&
    manifest.manifestVersion === row.manifest_version &&
    manifest.deploymentFingerprint === row.deployment_fingerprint &&
    manifest.sourceAuthorityIncarnation === row.source_authority_incarnation &&
    manifest.productVersion === row.product_version &&
    manifest.schemaVersion === row.schema_version &&
    manifest.migrationDigest === row.migration_digest &&
    manifest.algorithm === row.algorithm &&
    manifest.keyId === row.key_id &&
    manifest.chunkBytes === row.chunk_bytes &&
    manifest.plaintextBytes === row.plaintext_bytes &&
    manifest.plaintextSha256 === row.plaintext_sha256 &&
    manifest.ciphertextBytes === row.ciphertext_bytes &&
    manifest.ciphertextSha256 === row.ciphertext_sha256 &&
    manifest.createdAt === row.created_at
  );
}

async function assessBackupUsability(
  input: Readonly<{
    row: RetentionRow;
    backupDirectory: string;
    masterKeys: ReadonlyMap<string, Uint8Array>;
    migrations: MigrationCatalog;
  }>,
): Promise<BackupUsability> {
  const path = join(resolve(input.backupDirectory), `${input.row.id}.2collab-backup`);
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile()) return { kind: "CORRUPT", reason: "MISSING" };
  if (metadata.size < 1 || metadata.size > MAX_BACKUP_BYTES) {
    return { kind: "CORRUPT", reason: "SIZE_INVALID" };
  }
  const parsed = await readUnauthenticatedBackupManifest(path);
  if (!parsed.ok || !manifestMatchesRecord(parsed.value, input.row)) {
    return { kind: "CORRUPT", reason: "MANIFEST_INVALID" };
  }
  const masterKey = input.masterKeys.get(input.row.key_id);
  if (!masterKey) return { kind: "UNAVAILABLE" };
  const verified = await authenticateAndDecryptBackup(path, masterKey);
  if (!verified.ok) {
    return verified.error.code === "BACKUP_AUTHENTICATION_FAILED"
      ? { kind: "UNAVAILABLE" }
      : { kind: "CORRUPT", reason: "INTEGRITY_INVALID" };
  }
  if (
    !input.migrations.supportsRestoreFrom(verified.value.manifest.schemaVersion) ||
    input.migrations.digestForVersion(verified.value.manifest.schemaVersion) !==
      verified.value.manifest.migrationDigest
  ) {
    return { kind: "UNAVAILABLE" };
  }
  let database: Database | undefined;
  try {
    database = Database.deserialize(verified.value.databaseBytes, { readonly: true, strict: true });
    input.migrations.verifyClaimedSchema(database, verified.value.manifest.schemaVersion);
    return { kind: "USABLE" };
  } catch {
    return { kind: "CORRUPT", reason: "DATABASE_INVALID" };
  } finally {
    database?.close();
  }
}

/** Applies all bounds together and always preserves at least one verified usable backup. */
export async function enforceBackupRetention(
  input: Readonly<{
    database: Database;
    backupDirectory: string;
    now: number;
    policy?: BackupRetentionPolicy;
    migrations: MigrationCatalog;
    masterKeys: ReadonlyMap<string, Uint8Array>;
    id: (prefix: string) => string;
  }>,
): Promise<Result<Readonly<{ deleted: number; retained: number }>>> {
  const policy = {
    maximumAgeSeconds: input.policy?.maximumAgeSeconds ?? 30 * 24 * 60 * 60,
    maximumVerifiedBackups: input.policy?.maximumVerifiedBackups ?? 10,
    maximumBytes: input.policy?.maximumBytes ?? 10 * 1024 * 1024 * 1024,
    minimumUsableBackups: input.policy?.minimumUsableBackups ?? 1,
  };
  if (
    !Number.isSafeInteger(input.now) ||
    input.now < 0 ||
    !Number.isSafeInteger(policy.maximumAgeSeconds) ||
    policy.maximumAgeSeconds < 1 ||
    !Number.isSafeInteger(policy.maximumVerifiedBackups) ||
    policy.maximumVerifiedBackups < 1 ||
    !Number.isSafeInteger(policy.maximumBytes) ||
    policy.maximumBytes < 1 ||
    !Number.isSafeInteger(policy.minimumUsableBackups) ||
    policy.minimumUsableBackups < 1 ||
    policy.minimumUsableBackups > policy.maximumVerifiedBackups
  ) {
    return failure("BACKUP_RETENTION_INVALID", "Backup retention policy is invalid.");
  }
  const rows = input.database
    .query<RetentionRow, []>(
      `SELECT id, format, manifest_version, deployment_fingerprint,
         source_authority_incarnation, product_version, schema_version, migration_digest,
         algorithm, key_id, chunk_bytes, plaintext_bytes, plaintext_sha256,
         ciphertext_bytes, ciphertext_sha256, created_at
       FROM backup_records
       WHERE state IN ('VERIFIED', 'RETAINED') ORDER BY created_at DESC, id DESC`,
    )
    .all();
  const usable: RetentionRow[] = [];
  try {
    for (const row of rows) {
      const assessment = await assessBackupUsability({
        row,
        backupDirectory: input.backupDirectory,
        masterKeys: input.masterKeys,
        migrations: input.migrations,
      });
      if (assessment.kind === "USABLE") {
        usable.push(row);
        continue;
      }
      if (assessment.kind === "CORRUPT") {
        inImmediateTransaction(input.database, () => {
          const changed = input.database
            .query<void, [string]>(
              "UPDATE backup_records SET state = 'FAILED' WHERE id = ? AND state IN ('VERIFIED', 'RETAINED')",
            )
            .run(row.id);
          if (changed.changes !== 1) throw new Error("BACKUP_RETENTION_STATE_CHANGED");
          input.database
            .query<void, [string, string, string, number]>(
              `INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at)
               VALUES (?, 'BACKUP_MARKED_UNUSABLE', 'HOST', 'CONTAINER', ?, ?, ?)`,
            )
            .run(input.id("audit"), row.id, canonical({ reason: assessment.reason }), input.now);
        });
      }
    }
  } catch {
    return failure("BACKUP_RETENTION_FAILED", "Backup retention failed.", "SAME_INPUT");
  }
  if (usable.length < policy.minimumUsableBackups) {
    return failure(
      "BACKUP_RETENTION_MINIMUM_UNAVAILABLE",
      "Backup retention minimum is unavailable.",
      "SAME_INPUT",
    );
  }
  let retainedBytes = 0;
  const retain = new Set<string>();
  for (const row of usable) {
    const requiredMinimum = retain.size < policy.minimumUsableBackups;
    const withinCount = retain.size < policy.maximumVerifiedBackups;
    const withinAge = input.now - row.created_at <= policy.maximumAgeSeconds;
    const withinBytes = retainedBytes + row.ciphertext_bytes <= policy.maximumBytes;
    if (requiredMinimum || (withinCount && withinAge && withinBytes)) {
      retain.add(row.id);
      retainedBytes += row.ciphertext_bytes;
    }
  }
  const deletions = usable.filter((row) => !retain.has(row.id));
  try {
    const alreadyDeleted = input.database
      .query<{ id: string }, []>("SELECT id FROM backup_records WHERE state = 'DELETED'")
      .all();
    for (const row of alreadyDeleted) {
      await rm(join(resolve(input.backupDirectory), `${row.id}.2collab-backup`), {
        force: true,
      });
    }
    for (const row of deletions) {
      const path = join(resolve(input.backupDirectory), `${row.id}.2collab-backup`);
      inImmediateTransaction(input.database, () => {
        input.database
          .query<void, [number, string]>(
            "UPDATE backup_records SET state = 'DELETED', deleted_at = ? WHERE id = ? AND state IN ('VERIFIED', 'RETAINED')",
          )
          .run(input.now, row.id);
        input.database
          .query<void, [string, string, string, number]>(
            `INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at)
             VALUES (?, 'BACKUP_RETIRED', 'HOST', 'CONTAINER', ?, ?, ?)`,
          )
          .run(input.id("audit"), row.id, canonical({ reason: "RETENTION" }), input.now);
      });
      const file = await stat(path).catch(() => null);
      if (file?.isFile()) await rm(path);
    }
    return { ok: true, value: { deleted: deletions.length, retained: retain.size } };
  } catch {
    return failure("BACKUP_RETENTION_FAILED", "Backup retention failed.", "SAME_INPUT");
  }
}
