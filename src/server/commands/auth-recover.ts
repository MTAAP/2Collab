import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { Result } from "../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../db/transaction.ts";

const RECOVERY_SECONDS = 10 * 60;

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
  invocationMode: "OFFLINE_CONTAINER";
  mountedBootstrapSecret: string;
  randomSecret?: () => string;
}>;

function error(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

function digest(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

export function createAuthRecoverCommand(dependencies: Dependencies) {
  if (
    dependencies.invocationMode !== "OFFLINE_CONTAINER" ||
    dependencies.mountedBootstrapSecret.length < 32
  )
    throw new Error("HOST_RECOVERY_CONFIGURATION_INVALID");
  const randomSecret = dependencies.randomSecret ?? (() => randomBytes(32).toString("base64url"));
  return {
    generate(
      input: Readonly<{ memberId: string }>,
    ): Result<Readonly<{ memberId: string; recoveryCode: string; expiresAt: number }>> {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.memberId))
        return error("HOST_RECOVERY_OWNER_INVALID", "Host recovery owner is invalid.");
      const owner = dependencies.database
        .query<{ id: string }, [string]>(
          "SELECT id FROM members WHERE id = ? AND role = 'OWNER' AND status = 'ACTIVE'",
        )
        .get(input.memberId);
      if (!owner) return error("HOST_RECOVERY_OWNER_INVALID", "Host recovery owner is invalid.");
      const recoveryCode = randomSecret();
      if (recoveryCode.length < 32 || recoveryCode.length > 512)
        return error("HOST_RECOVERY_FAILED", "Host recovery failed.");
      const now = dependencies.clock();
      try {
        return inImmediateTransaction(dependencies.database, () => {
          dependencies.database
            .query(
              "UPDATE host_recovery_codes SET revoked_at = ?, revision = revision + 1 WHERE member_id = ? AND consumed_at IS NULL AND revoked_at IS NULL",
            )
            .run(now, input.memberId);
          dependencies.database
            .query(
              `INSERT INTO host_recovery_codes(
                 id, member_id, code_hash, revision, created_at, expires_at
               ) VALUES (?, ?, ?, 1, ?, ?)`,
            )
            .run(
              dependencies.id("host_recovery"),
              input.memberId,
              digest(recoveryCode),
              now,
              now + RECOVERY_SECONDS,
            );
          dependencies.database
            .query(
              "INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at) VALUES (?, 'HOST_RECOVERY_GENERATED', 'HOST', 'CONTAINER', ?, ?, ?)",
            )
            .run(
              dependencies.id("audit"),
              input.memberId,
              JSON.stringify({ disposition: "GENERATED", expiresInSeconds: RECOVERY_SECONDS }),
              now,
            );
          return {
            ok: true,
            value: { memberId: input.memberId, recoveryCode, expiresAt: now + RECOVERY_SECONDS },
          };
        });
      } catch {
        return error("HOST_RECOVERY_FAILED", "Host recovery failed.");
      }
    },

    redeem(
      input: Readonly<{ memberId: string; recoveryCode: string }>,
    ): Result<Readonly<{ sessionId: string; sessionProof: string; expiresAt: number }>> {
      if (input.recoveryCode.length < 32 || input.recoveryCode.length > 512)
        return error("HOST_RECOVERY_CODE_INVALID", "Host recovery code is invalid.");
      const row = dependencies.database
        .query<{ id: string; revision: number }, [string, Uint8Array, number]>(
          `SELECT id, revision FROM host_recovery_codes
           WHERE member_id = ? AND code_hash = ? AND consumed_at IS NULL
             AND revoked_at IS NULL AND expires_at > ?`,
        )
        .get(input.memberId, digest(input.recoveryCode), dependencies.clock());
      if (!row) return error("HOST_RECOVERY_CODE_INVALID", "Host recovery code is invalid.");
      const proof = randomSecret();
      const now = dependencies.clock();
      const sessionId = dependencies.id("host_recovery_session");
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const consumed = dependencies.database
            .query(
              "UPDATE host_recovery_codes SET consumed_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
            )
            .run(now, row.id, row.revision, now);
          const owner = dependencies.database
            .query<{ authority_epoch: number }, [string]>(
              "SELECT authority_epoch FROM members WHERE id = ? AND role = 'OWNER' AND status = 'ACTIVE'",
            )
            .get(input.memberId);
          if (consumed.changes !== 1 || !owner)
            return error("HOST_RECOVERY_CODE_INVALID", "Host recovery code is invalid.");
          dependencies.database
            .query(
              `INSERT INTO sessions(
                 id, member_id, proof_hash, kind, expires_at, absolute_expires_at,
                 member_authority_epoch, revision, created_at
               ) VALUES (?, ?, ?, 'HOST_RECOVERY', ?, ?, ?, 1, ?)`,
            )
            .run(
              sessionId,
              input.memberId,
              digest(proof),
              now + RECOVERY_SECONDS,
              now + RECOVERY_SECONDS,
              owner.authority_epoch,
              now,
            );
          dependencies.database
            .query(
              "INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at) VALUES (?, 'HOST_RECOVERY_REDEEMED', 'HOST', 'CONTAINER', ?, ?, ?)",
            )
            .run(
              dependencies.id("audit"),
              input.memberId,
              JSON.stringify({ disposition: "REDEEMED" }),
              now,
            );
          return {
            ok: true,
            value: { sessionId, sessionProof: proof, expiresAt: now + RECOVERY_SECONDS },
          };
        });
      } catch {
        return error("HOST_RECOVERY_FAILED", "Host recovery failed.");
      }
    },
  };
}
