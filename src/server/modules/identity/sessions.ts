import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";

const BROWSER_IDLE_SECONDS = 12 * 60 * 60;
const BROWSER_ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;
const DPOP_CLOCK_SKEW_SECONDS = 5 * 60;
const DPOP_REPLAY_SECONDS = 10 * 60;

function error(code: string, message: string, retry: "NEVER" | "REFRESH" = "NEVER"): Result<never> {
  return { ok: false, error: { code, message, retry } };
}

function defaultSecret(): string {
  return randomBytes(32).toString("base64url");
}

function sha256(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

export type BrowserSessionAccess = Readonly<{
  sessionId: string;
  memberId: string;
  role: "OWNER" | "MEMBER";
  memberAuthorityEpoch: number;
  csrfHash: Uint8Array;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}>;

type SessionDependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
  randomSecret?: () => string;
  digest?: (value: string) => Promise<Uint8Array>;
}>;

export function createSessionAuthority(dependencies: SessionDependencies) {
  const digest = dependencies.digest ?? (async (value: string) => sha256(value));
  const secret = dependencies.randomSecret ?? defaultSecret;

  const verify = async (actor: MemberActor): Promise<Result<BrowserSessionAccess>> => {
    if (actor.sessionProof.length < 32 || actor.sessionProof.length > 512)
      return error("SESSION_INVALID", "Member session is invalid.");
    const proofHash = await digest(actor.sessionProof);
    const row = dependencies.database
      .query<
        Readonly<{
          session_id: string;
          member_id: string;
          role: "OWNER" | "MEMBER";
          authority_epoch: number;
          csrf_hash: Uint8Array;
          idle_expires_at: number;
          absolute_expires_at: number;
        }>,
        [string, string, Uint8Array, number, number]
      >(
        `SELECT sessions.id AS session_id, members.id AS member_id, members.role,
                members.authority_epoch, sessions.csrf_hash, sessions.idle_expires_at,
                sessions.absolute_expires_at
         FROM sessions JOIN members ON members.id = sessions.member_id
         WHERE sessions.id = ? AND members.id = ? AND sessions.proof_hash = ?
           AND sessions.kind = 'BROWSER' AND sessions.revoked_at IS NULL
           AND sessions.idle_expires_at > ? AND sessions.absolute_expires_at > ?
           AND members.status = 'ACTIVE'
           AND sessions.member_authority_epoch = members.authority_epoch`,
      )
      .get(actor.sessionId, actor.memberId, proofHash, dependencies.clock(), dependencies.clock());
    return row
      ? {
          ok: true,
          value: {
            sessionId: row.session_id,
            memberId: row.member_id,
            role: row.role,
            memberAuthorityEpoch: row.authority_epoch,
            csrfHash: row.csrf_hash,
            idleExpiresAt: row.idle_expires_at,
            absoluteExpiresAt: row.absolute_expires_at,
          },
        }
      : error("SESSION_INVALID", "Member session is invalid.");
  };

  return {
    verify,

    async verifyCookie(
      input: Readonly<{ sessionId: string; sessionProof: string }>,
    ): Promise<Result<BrowserSessionAccess>> {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.sessionId) ||
        input.sessionProof.length < 32 ||
        input.sessionProof.length > 512
      )
        return error("SESSION_INVALID", "Member session is invalid.");
      const proofHash = await digest(input.sessionProof);
      const row = dependencies.database
        .query<
          Readonly<{
            session_id: string;
            member_id: string;
            role: "OWNER" | "MEMBER";
            authority_epoch: number;
            csrf_hash: Uint8Array;
            idle_expires_at: number;
            absolute_expires_at: number;
          }>,
          [string, Uint8Array, number, number]
        >(
          `SELECT sessions.id AS session_id, members.id AS member_id, members.role,
                  members.authority_epoch, sessions.csrf_hash, sessions.idle_expires_at,
                  sessions.absolute_expires_at
           FROM sessions JOIN members ON members.id = sessions.member_id
           WHERE sessions.id = ? AND sessions.proof_hash = ?
             AND sessions.kind = 'BROWSER' AND sessions.revoked_at IS NULL
             AND sessions.idle_expires_at > ? AND sessions.absolute_expires_at > ?
             AND members.status = 'ACTIVE'
             AND sessions.member_authority_epoch = members.authority_epoch`,
        )
        .get(input.sessionId, proofHash, dependencies.clock(), dependencies.clock());
      return row
        ? {
            ok: true,
            value: {
              sessionId: row.session_id,
              memberId: row.member_id,
              role: row.role,
              memberAuthorityEpoch: row.authority_epoch,
              csrfHash: row.csrf_hash,
              idleExpiresAt: row.idle_expires_at,
              absoluteExpiresAt: row.absolute_expires_at,
            },
          }
        : error("SESSION_INVALID", "Member session is invalid.");
    },

    async issue(memberId: string): Promise<
      Result<
        Readonly<{
          actor: MemberActor;
          csrfProof: string;
          idleExpiresAt: number;
          absoluteExpiresAt: number;
        }>
      >
    > {
      const row = dependencies.database
        .query<{ authority_epoch: number }, [string]>(
          "SELECT authority_epoch FROM members WHERE id = ? AND status = 'ACTIVE'",
        )
        .get(memberId);
      if (!row) return error("MEMBER_NOT_ACTIVE", "Member is not active.");
      const proof = secret();
      const csrfProof = secret();
      const [proofHash, csrfHash] = await Promise.all([digest(proof), digest(csrfProof)]);
      const sessionId = dependencies.id("session");
      const now = dependencies.clock();
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const current = dependencies.database
            .query<{ authority_epoch: number }, [string, number]>(
              "SELECT authority_epoch FROM members WHERE id = ? AND status = 'ACTIVE' AND authority_epoch = ?",
            )
            .get(memberId, row.authority_epoch);
          if (!current) return error("AUTHORITY_STALE", "Identity authority changed.", "REFRESH");
          dependencies.database
            .query(
              `INSERT INTO sessions(
                 id, member_id, proof_hash, kind, expires_at, idle_expires_at,
                 absolute_expires_at, csrf_hash, member_authority_epoch, revision, created_at
               ) VALUES (?, ?, ?, 'BROWSER', ?, ?, ?, ?, ?, 1, ?)`,
            )
            .run(
              sessionId,
              memberId,
              proofHash,
              now + BROWSER_ABSOLUTE_SECONDS,
              now + BROWSER_IDLE_SECONDS,
              now + BROWSER_ABSOLUTE_SECONDS,
              csrfHash,
              row.authority_epoch,
              now,
            );
          return {
            ok: true,
            value: {
              actor: {
                kind: "MEMBER",
                memberId: memberId as never,
                sessionId: sessionId as never,
                sessionProof: proof,
              },
              csrfProof,
              idleExpiresAt: now + BROWSER_IDLE_SECONDS,
              absoluteExpiresAt: now + BROWSER_ABSOLUTE_SECONDS,
            },
          };
        });
      } catch {
        return error("SESSION_OPERATION_FAILED", "Session operation failed.");
      }
    },

    async rotate(actor: MemberActor): Promise<
      Result<
        Readonly<{
          actor: MemberActor;
          csrfProof: string;
          idleExpiresAt: number;
          absoluteExpiresAt: number;
        }>
      >
    > {
      const current = await verify(actor);
      if (!current.ok) return current;
      const proof = secret();
      const csrfProof = secret();
      const [oldProofHash, proofHash, csrfHash] = await Promise.all([
        digest(actor.sessionProof),
        digest(proof),
        digest(csrfProof),
      ]);
      const nextId = dependencies.id("session");
      const now = dependencies.clock();
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const revoked = dependencies.database
            .query(
              `UPDATE sessions SET revoked_at = ?, revision = revision + 1
               WHERE id = ? AND member_id = ? AND proof_hash = ? AND revision > 0
                 AND revoked_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ?
                 AND member_authority_epoch = ?`,
            )
            .run(
              now,
              actor.sessionId,
              actor.memberId,
              oldProofHash,
              now,
              now,
              current.value.memberAuthorityEpoch,
            );
          if (revoked.changes !== 1)
            return error("SESSION_ROTATION_REPLAY", "Member session was already rotated.");
          const absoluteExpiresAt = current.value.absoluteExpiresAt;
          const idleExpiresAt = Math.min(absoluteExpiresAt, now + BROWSER_IDLE_SECONDS);
          dependencies.database
            .query(
              `INSERT INTO sessions(
                 id, member_id, proof_hash, kind, expires_at, idle_expires_at,
                 absolute_expires_at, csrf_hash, member_authority_epoch, revision,
                 created_at, rotated_from_id
               ) VALUES (?, ?, ?, 'BROWSER', ?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              nextId,
              actor.memberId,
              proofHash,
              absoluteExpiresAt,
              idleExpiresAt,
              absoluteExpiresAt,
              csrfHash,
              current.value.memberAuthorityEpoch,
              now,
              actor.sessionId,
            );
          return {
            ok: true,
            value: {
              actor: {
                kind: "MEMBER",
                memberId: actor.memberId,
                sessionId: nextId as never,
                sessionProof: proof,
              },
              csrfProof,
              idleExpiresAt,
              absoluteExpiresAt,
            },
          };
        });
      } catch {
        return error("SESSION_OPERATION_FAILED", "Session operation failed.");
      }
    },
  };
}

export type DpopClaims = Readonly<{
  jti: string;
  method: string;
  uri: string;
  issuedAt: number;
  nonce: string;
  senderKeyThumbprint: string;
  accessTokenHash: string;
}>;

type DpopDependencies = Readonly<{
  database: Database;
  clock: () => number;
  verifyProof: (proof: string) => Promise<DpopClaims>;
}>;

function normalizeUri(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.hash ||
      url.username ||
      url.password
    )
      return null;
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    )
      url.port = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function createDpopVerifier(dependencies: DpopDependencies) {
  return {
    async verify(
      input: Readonly<{
        proof: string;
        method: string;
        uri: string;
        nonce: string;
        senderKeyThumbprint: string;
        accessTokenHash: string;
      }>,
    ): Promise<Result<Readonly<{ verified: true }>>> {
      if (
        input.proof.length < 1 ||
        input.proof.length > 8_192 ||
        input.nonce.length < 1 ||
        input.nonce.length > 512 ||
        !/^[a-f0-9]{64}$/.test(input.accessTokenHash)
      ) {
        return error("DPOP_INVALID", "DPoP proof is invalid.");
      }
      let claims: DpopClaims;
      try {
        claims = await dependencies.verifyProof(input.proof);
      } catch {
        return error("DPOP_INVALID", "DPoP proof is invalid.");
      }
      const expectedUri = normalizeUri(input.uri);
      const actualUri = normalizeUri(claims.uri);
      const now = dependencies.clock();
      if (
        !expectedUri ||
        actualUri !== expectedUri ||
        claims.method.toUpperCase() !== input.method.toUpperCase() ||
        claims.nonce !== input.nonce ||
        claims.senderKeyThumbprint !== input.senderKeyThumbprint ||
        claims.accessTokenHash !== input.accessTokenHash ||
        !Number.isInteger(claims.issuedAt) ||
        Math.abs(now - claims.issuedAt) > DPOP_CLOCK_SKEW_SECONDS ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(claims.jti)
      ) {
        return error("DPOP_INVALID", "DPoP proof is invalid.");
      }
      const replayHash = sha256(`${claims.senderKeyThumbprint}:${claims.jti}`);
      try {
        return inImmediateTransaction(dependencies.database, () => {
          dependencies.database.query("DELETE FROM dpop_replays WHERE expires_at <= ?").run(now);
          const inserted = dependencies.database
            .query(
              "INSERT OR IGNORE INTO dpop_replays(proof_id_hash, sender_key_thumbprint, created_at, expires_at) VALUES (?, ?, ?, ?)",
            )
            .run(replayHash, claims.senderKeyThumbprint, now, now + DPOP_REPLAY_SECONDS);
          return inserted.changes === 1
            ? { ok: true, value: { verified: true as const } }
            : error("DPOP_REPLAY", "DPoP proof was already used.");
        });
      } catch {
        return error("DPOP_INVALID", "DPoP proof is invalid.");
      }
    },
  };
}
