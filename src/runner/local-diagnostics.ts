import type { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv } from "node:crypto";
import type { Result } from "../shared/contracts/result.ts";
import type { LocalSecretStore } from "./credentials/os-store.ts";

const MAXIMUM_BYTES = 2 * 1024 * 1024;
const MAXIMUM_AGE_SECONDS = 24 * 60 * 60;

type Metadata = Readonly<{
  enabled: true;
  byteCount: number;
  expiresAt: number;
  correlationId: string;
}>;

type Row = Readonly<{
  correlation_id: string;
  owner_member_id: string;
  interaction: "HEADLESS" | "INTERACTIVE";
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  auth_tag: Uint8Array;
  byte_count: number;
  enabled: 1;
  revision: number;
  created_at: number;
  expires_at: number;
}>;

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  randomBytes: (length: number) => Uint8Array;
  secrets: LocalSecretStore;
  reauthenticate: (ownerMemberId: string, proof: string) => Promise<boolean>;
}>;

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

function metadata(row: Row): Metadata {
  return {
    enabled: true,
    byteCount: row.byte_count,
    expiresAt: row.expires_at,
    correlationId: row.correlation_id,
  };
}

function aad(row: Pick<Row, "correlation_id" | "owner_member_id" | "expires_at">): Buffer {
  return Buffer.from(
    `2collab-local-diagnostic-v1\0${row.correlation_id}\0${row.owner_member_id}\0${row.expires_at}`,
    "utf8",
  );
}

export function createLocalDiagnostics(dependencies: Dependencies) {
  const key = Buffer.from(dependencies.secrets.getOrCreate("2collab.runner.diagnostics.v1"));
  if (key.byteLength !== 32) throw new Error("DIAGNOSTIC_KEY_INVALID");

  const encrypt = (
    plaintext: Uint8Array,
    facts: Pick<Row, "correlation_id" | "owner_member_id" | "expires_at">,
  ) => {
    const nonce = Buffer.from(dependencies.randomBytes(12));
    if (nonce.byteLength !== 12) throw new Error("DIAGNOSTIC_RANDOM_INVALID");
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(facts));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext, nonce, authTag: cipher.getAuthTag() };
  };

  const decrypt = (row: Row): Buffer => {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.nonce));
    decipher.setAAD(aad(row));
    decipher.setAuthTag(Buffer.from(row.auth_tag));
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
  };

  const read = (correlationId: string): Row | null =>
    dependencies.database
      .query<Row, [string]>("SELECT * FROM local_diagnostic_tails WHERE correlation_id = ?")
      .get(correlationId);

  const purgeExpiredRow = (row: Row): boolean => {
    if (dependencies.clock() < row.expires_at) return false;
    try {
      dependencies.database
        .query(
          "DELETE FROM local_diagnostic_tails WHERE correlation_id = ? AND revision = ? AND expires_at <= ?",
        )
        .run(row.correlation_id, row.revision, dependencies.clock());
    } catch {
      // Expiry is authoritative even when best-effort payload removal cannot complete.
    }
    return true;
  };

  return {
    enable(
      correlationId: string,
      ownerMemberId: string,
      interaction: "HEADLESS" | "INTERACTIVE",
      options: Readonly<{ allowInteractive?: boolean }> = {},
    ): Result<Metadata> {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(correlationId) ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(ownerMemberId)
      ) {
        return failure("DIAGNOSTIC_INPUT_INVALID", "Diagnostic input is invalid.");
      }
      if (interaction === "INTERACTIVE" && options.allowInteractive !== true) {
        return failure(
          "DIAGNOSTIC_INTERACTIVE_DISABLED",
          "Interactive diagnostic collection is disabled.",
        );
      }
      const now = dependencies.clock();
      const facts = {
        correlation_id: correlationId,
        owner_member_id: ownerMemberId,
        expires_at: now + MAXIMUM_AGE_SECONDS,
      };
      const encrypted = encrypt(new Uint8Array(), facts);
      try {
        dependencies.database
          .query(
            `INSERT INTO local_diagnostic_tails(
               correlation_id, owner_member_id, interaction, ciphertext, nonce, auth_tag,
               byte_count, enabled, revision, created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?)`,
          )
          .run(
            correlationId,
            ownerMemberId,
            interaction,
            encrypted.ciphertext,
            encrypted.nonce,
            encrypted.authTag,
            now,
            facts.expires_at,
          );
        const row = read(correlationId);
        return row
          ? { ok: true, value: metadata(row) }
          : failure("DIAGNOSTIC_STORAGE_FAILED", "Diagnostic storage failed.");
      } catch {
        return failure("DIAGNOSTIC_ALREADY_ENABLED", "Diagnostic collection is already enabled.");
      }
    },

    append(correlationId: string, text: string): Result<Metadata> {
      const row = read(correlationId);
      if (!row) return failure("DIAGNOSTIC_NOT_FOUND", "Diagnostic collection was not found.");
      if (purgeExpiredRow(row)) {
        return failure("DIAGNOSTIC_EXPIRED", "Diagnostic collection expired.");
      }
      const incoming = Buffer.from(text, "utf8");
      if (row.byte_count + incoming.byteLength > MAXIMUM_BYTES) {
        return failure("DIAGNOSTIC_LIMIT_REACHED", "Diagnostic byte limit was reached.");
      }
      try {
        const plaintext = Buffer.concat([decrypt(row), incoming]);
        const encrypted = encrypt(plaintext, row);
        const changed = dependencies.database
          .query(
            `UPDATE local_diagnostic_tails SET ciphertext = ?, nonce = ?, auth_tag = ?,
               byte_count = ?, revision = revision + 1
             WHERE correlation_id = ? AND revision = ? AND enabled = 1 AND expires_at > ?`,
          )
          .run(
            encrypted.ciphertext,
            encrypted.nonce,
            encrypted.authTag,
            plaintext.byteLength,
            correlationId,
            row.revision,
            dependencies.clock(),
          );
        const current = read(correlationId);
        return changed.changes === 1 && current
          ? { ok: true, value: metadata(current) }
          : failure("DIAGNOSTIC_STATE_CHANGED", "Diagnostic collection changed.");
      } catch {
        return failure("DIAGNOSTIC_STORAGE_FAILED", "Diagnostic storage failed.");
      }
    },

    metadata(correlationId: string): Result<Metadata> {
      const row = read(correlationId);
      if (row && purgeExpiredRow(row)) {
        return failure("DIAGNOSTIC_EXPIRED", "Diagnostic collection expired.");
      }
      return row
        ? { ok: true, value: metadata(row) }
        : failure("DIAGNOSTIC_NOT_FOUND", "Diagnostic collection was not found.");
    },

    async reveal(
      correlationId: string,
      ownerMemberId: string,
      proof: string,
    ): Promise<Result<string>> {
      const row = read(correlationId);
      if (!row) return failure("DIAGNOSTIC_NOT_FOUND", "Diagnostic collection was not found.");
      if (row.owner_member_id !== ownerMemberId) {
        return failure("DIAGNOSTIC_OWNER_REQUIRED", "Diagnostic owner authorization is required.");
      }
      if (!(await dependencies.reauthenticate(ownerMemberId, proof))) {
        return failure("DIAGNOSTIC_REAUTH_REQUIRED", "Fresh owner authentication is required.");
      }
      if (purgeExpiredRow(row)) {
        return failure("DIAGNOSTIC_EXPIRED", "Diagnostic collection expired.");
      }
      try {
        return { ok: true, value: decrypt(row).toString("utf8") };
      } catch {
        return failure("DIAGNOSTIC_STORAGE_FAILED", "Diagnostic storage failed.");
      }
    },

    async disable(
      correlationId: string,
      ownerMemberId: string,
      proof: string,
    ): Promise<Result<Readonly<{ disabled: true }>>> {
      const row = read(correlationId);
      if (!row) return failure("DIAGNOSTIC_NOT_FOUND", "Diagnostic collection was not found.");
      if (row.owner_member_id !== ownerMemberId) {
        return failure("DIAGNOSTIC_OWNER_REQUIRED", "Diagnostic owner authorization is required.");
      }
      if (!(await dependencies.reauthenticate(ownerMemberId, proof))) {
        return failure("DIAGNOSTIC_REAUTH_REQUIRED", "Fresh owner authentication is required.");
      }
      if (purgeExpiredRow(row)) {
        return failure("DIAGNOSTIC_EXPIRED", "Diagnostic collection expired.");
      }
      try {
        const deleted = dependencies.database
          .query(
            "DELETE FROM local_diagnostic_tails WHERE correlation_id = ? AND owner_member_id = ? AND revision = ?",
          )
          .run(correlationId, ownerMemberId, row.revision);
        return deleted.changes === 1
          ? { ok: true, value: { disabled: true } }
          : failure("DIAGNOSTIC_STATE_CHANGED", "Diagnostic collection changed.");
      } catch {
        return failure("DIAGNOSTIC_STORAGE_FAILED", "Diagnostic storage failed.");
      }
    },

    purgeExpired(): Readonly<{ purged: number }> {
      const result = dependencies.database
        .query("DELETE FROM local_diagnostic_tails WHERE expires_at <= ?")
        .run(dependencies.clock());
      return { purged: result.changes };
    },
  };
}
