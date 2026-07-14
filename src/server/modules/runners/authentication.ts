import type { Database } from "bun:sqlite";
import type { VerifiedRunnerPrincipal } from "../../../shared/contracts/actors.ts";
import type { RegisteredRunnerId, MemberId } from "../../../shared/contracts/ids.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { RunnerAccessIssue } from "../../../shared/contracts/runners.ts";
import type {
  RunnerAuthenticationAuthority,
  RunnerKeyProofPort,
  RunnerRequestProofPort,
} from "./contract.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import { runnerDigest, runnerSecret, validRunnerId } from "./pairing.ts";

const RUNNER_ACCESS_SECONDS = 600;

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  randomSecret?: (prefix: string) => string;
  digest?: (value: string) => Promise<Uint8Array>;
  runnerKeyProof: RunnerKeyProofPort;
  runnerRequestProof: RunnerRequestProofPort;
}>;

type AccessClaims = Readonly<{
  runnerId: string;
  runnerEpoch: number;
  ownerMemberId: string;
  keyThumbprint: string;
  expiresAt: number;
  nonce: string;
}>;

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

export function createRunnerAuthenticationAuthority(
  dependencies: Dependencies,
): RunnerAuthenticationAuthority {
  const digest = dependencies.digest ?? runnerDigest;
  const randomSecret = dependencies.randomSecret ?? runnerSecret;
  const access = new Map<string, AccessClaims>();
  const purgeExpiredAccess = (now: number): void => {
    for (const [tokenHash, claims] of access) {
      if (claims.expiresAt <= now) access.delete(tokenHash);
    }
  };

  const authenticateAccess: RunnerAuthenticationAuthority["authenticateAccess"] = async (
    command,
  ) => {
    if (
      command.accessToken.length < 32 ||
      command.accessToken.length > 512 ||
      command.proof.length < 1 ||
      command.proof.length > 8_192 ||
      command.nonce.length < 32 ||
      command.nonce.length > 512 ||
      command.method !== "GET"
    ) {
      return failure("RUNNER_ACCESS_INVALID", "Runner access credential is invalid.");
    }
    let normalizedUri: string;
    try {
      const url = new URL(command.uri);
      if (
        url.protocol !== "https:" ||
        url.pathname !== "/runner/v1" ||
        url.search !== "" ||
        url.hash !== "" ||
        url.username !== "" ||
        url.password !== ""
      ) {
        return failure("RUNNER_ACCESS_INVALID", "Runner access credential is invalid.");
      }
      normalizedUri = url.toString();
      if (normalizedUri !== command.uri) {
        return failure("RUNNER_ACCESS_INVALID", "Runner access credential is invalid.");
      }
    } catch {
      return failure("RUNNER_ACCESS_INVALID", "Runner access credential is invalid.");
    }
    const tokenHash = Buffer.from(await digest(command.accessToken)).toString("hex");
    purgeExpiredAccess(dependencies.clock());
    const claims = access.get(tokenHash);
    if (!claims || dependencies.clock() >= claims.expiresAt || command.nonce !== claims.nonce) {
      return failure("RUNNER_ACCESS_INVALID", "Runner access credential is invalid.");
    }
    const requestProof = await dependencies.runnerRequestProof.verify({
      keyThumbprint: claims.keyThumbprint,
      proof: command.proof,
      method: command.method,
      uri: normalizedUri,
      nonce: command.nonce,
      accessTokenHash: tokenHash,
      now: dependencies.clock(),
    });
    if (!requestProof.ok) return requestProof;
    if (
      !validRunnerId(requestProof.value.jti) ||
      Math.abs(dependencies.clock() - requestProof.value.issuedAt) > 300
    ) {
      return failure("RUNNER_DPOP_INVALID", "Runner request proof is invalid.");
    }
    const proofIdHash = await digest(
      `RUNNER_DPOP:${claims.keyThumbprint}:${requestProof.value.jti}`,
    );
    try {
      const accepted = inImmediateTransaction(dependencies.database, () => {
        const now = dependencies.clock();
        if (now >= claims.expiresAt) {
          return false;
        }
        dependencies.database.query("DELETE FROM dpop_replays WHERE expires_at <= ?").run(now);
        const current = dependencies.database
          .query<{ id: string }, [string, number, string, string]>(
            `SELECT runners.id FROM runners
             JOIN members ON members.id = runners.owner_member_id
             JOIN runner_credentials AS credentials ON credentials.runner_id = runners.id
             WHERE runners.id = ? AND runners.runner_epoch = ? AND runners.owner_member_id = ?
               AND runners.revoked_at IS NULL AND members.status = 'ACTIVE'
               AND credentials.key_thumbprint = ? AND credentials.revoked_at IS NULL
               AND credentials.runner_epoch = runners.runner_epoch
               AND credentials.member_authority_epoch = members.authority_epoch`,
          )
          .get(claims.runnerId, claims.runnerEpoch, claims.ownerMemberId, claims.keyThumbprint);
        if (!current) return false;
        dependencies.database
          .query(
            `INSERT INTO dpop_replays(proof_id_hash, sender_key_thumbprint, created_at, expires_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(proofIdHash, claims.keyThumbprint, now, now + 600);
        return true;
      });
      if (!accepted) {
        return failure("RUNNER_ACCESS_INVALID", "Runner access credential is invalid.");
      }
    } catch {
      return failure("RUNNER_DPOP_REPLAY", "Runner request proof was replayed.");
    }
    return {
      ok: true,
      value: {
        kind: "VERIFIED_RUNNER",
        runnerId: claims.runnerId as RegisteredRunnerId,
        runnerEpoch: claims.runnerEpoch,
        ownerMemberId: claims.ownerMemberId as MemberId,
        keyThumbprint: claims.keyThumbprint,
        accessExpiresAt: claims.expiresAt,
      } as VerifiedRunnerPrincipal,
    };
  };

  return {
    async exchangeCredential(command) {
      purgeExpiredAccess(dependencies.clock());
      if (command.runnerCredential.length < 32 || command.runnerCredential.length > 512) {
        return failure("RUNNER_CREDENTIAL_INVALID", "Runner credential is invalid.");
      }
      const credentialHash = await digest(command.runnerCredential);
      const row = dependencies.database
        .query<
          {
            credential_id: string;
            runner_id: string;
            runner_epoch: number;
            owner_member_id: string;
            key_thumbprint: string;
          },
          [Uint8Array]
        >(
          `SELECT credentials.id AS credential_id, runners.id AS runner_id,
                  runners.runner_epoch, runners.owner_member_id,
                  credentials.key_thumbprint
           FROM runner_credentials AS credentials
           JOIN runners ON runners.id = credentials.runner_id
           JOIN members ON members.id = runners.owner_member_id
           WHERE credentials.credential_hash = ? AND credentials.revoked_at IS NULL
             AND credentials.runner_epoch = runners.runner_epoch
             AND credentials.member_authority_epoch = members.authority_epoch
             AND runners.revoked_at IS NULL AND members.status = 'ACTIVE'`,
        )
        .get(credentialHash);
      if (!row) return failure("RUNNER_CREDENTIAL_INVALID", "Runner credential is invalid.");
      const proof = await dependencies.runnerKeyProof.verifyPossession({
        keyThumbprint: row.key_thumbprint,
        proof: command.keyProof,
      });
      if (!proof.ok) return proof;
      const accessToken = randomSecret("runner_access");
      const nonce = randomSecret("runner_nonce");
      const tokenHash = Buffer.from(await digest(accessToken)).toString("hex");
      const current = inImmediateTransaction(dependencies.database, () =>
        dependencies.database
          .query<
            {
              runner_id: string;
              runner_epoch: number;
              owner_member_id: string;
              key_thumbprint: string;
            },
            [string, Uint8Array, string, number, string]
          >(
            `SELECT runners.id AS runner_id, runners.runner_epoch, runners.owner_member_id,
                    credentials.key_thumbprint
             FROM runner_credentials AS credentials
             JOIN runners ON runners.id = credentials.runner_id
             JOIN members ON members.id = runners.owner_member_id
             WHERE credentials.id = ? AND credentials.credential_hash = ?
               AND credentials.key_thumbprint = ? AND credentials.runner_epoch = ?
               AND credentials.member_authority_epoch = members.authority_epoch
               AND credentials.revoked_at IS NULL
               AND runners.id = ? AND runners.runner_epoch = credentials.runner_epoch
               AND runners.revoked_at IS NULL AND members.status = 'ACTIVE'`,
          )
          .get(
            row.credential_id,
            credentialHash,
            row.key_thumbprint,
            row.runner_epoch,
            row.runner_id,
          ),
      );
      if (!current) return failure("RUNNER_CREDENTIAL_INVALID", "Runner credential is invalid.");
      const expiresAt = dependencies.clock() + RUNNER_ACCESS_SECONDS;
      access.set(tokenHash, {
        runnerId: current.runner_id,
        runnerEpoch: current.runner_epoch,
        ownerMemberId: current.owner_member_id,
        keyThumbprint: current.key_thumbprint,
        expiresAt,
        nonce,
      });
      return {
        ok: true,
        value: {
          accessToken,
          nonce,
          runnerId: current.runner_id as RegisteredRunnerId,
          runnerEpoch: current.runner_epoch,
          keyThumbprint: current.key_thumbprint,
          expiresAt,
        } satisfies RunnerAccessIssue,
      };
    },

    authenticateAccess,
    authenticateUpgrade: authenticateAccess,
  };
}
