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
    const current = dependencies.database
      .query<{ id: string }, [string, number, string]>(
        `SELECT runners.id FROM runners JOIN members ON members.id = runners.owner_member_id
         WHERE runners.id = ? AND runners.runner_epoch = ? AND runners.owner_member_id = ?
           AND runners.revoked_at IS NULL AND members.status = 'ACTIVE'`,
      )
      .get(claims.runnerId, claims.runnerEpoch, claims.ownerMemberId);
    if (!current) return failure("RUNNER_ACCESS_INVALID", "Runner access credential is invalid.");
    const proofIdHash = await digest(`RUNNER_DPOP:${requestProof.value.jti}`);
    try {
      dependencies.database
        .query(
          `INSERT INTO dpop_replays(proof_id_hash, sender_key_thumbprint, created_at, expires_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(proofIdHash, claims.keyThumbprint, dependencies.clock(), dependencies.clock() + 600);
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
      if (command.runnerCredential.length < 32 || command.runnerCredential.length > 512) {
        return failure("RUNNER_CREDENTIAL_INVALID", "Runner credential is invalid.");
      }
      const credentialHash = await digest(command.runnerCredential);
      const row = dependencies.database
        .query<
          {
            runner_id: string;
            runner_epoch: number;
            owner_member_id: string;
            key_thumbprint: string;
          },
          [Uint8Array]
        >(
          `SELECT runners.id AS runner_id, runners.runner_epoch, runners.owner_member_id,
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
      const expiresAt = dependencies.clock() + RUNNER_ACCESS_SECONDS;
      const tokenHash = Buffer.from(await digest(accessToken)).toString("hex");
      access.set(tokenHash, {
        runnerId: row.runner_id,
        runnerEpoch: row.runner_epoch,
        ownerMemberId: row.owner_member_id,
        keyThumbprint: row.key_thumbprint,
        expiresAt,
        nonce,
      });
      return {
        ok: true,
        value: {
          accessToken,
          nonce,
          runnerId: row.runner_id as RegisteredRunnerId,
          runnerEpoch: row.runner_epoch,
          keyThumbprint: row.key_thumbprint,
          expiresAt,
        } satisfies RunnerAccessIssue,
      };
    },

    authenticateAccess,
    authenticateUpgrade: authenticateAccess,
  };
}
