import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import type { VerifiedProviderIdentity } from "./oidc.ts";

declare const proxyProvenanceBrand: unique symbol;
export type VerifiedProxyProvenance = Readonly<{
  directPeer: string;
  forwardedOrigin: string;
  verifiedAt: number;
  [proxyProvenanceBrand]: true;
}>;

export interface AuthProxyAssertionPort {
  verify(
    input: Readonly<{
      assertion: string;
      issuer: string;
      audience: string;
      provenance: VerifiedProxyProvenance;
    }>,
  ): Promise<
    Result<
      Readonly<{
        issuer: string;
        audience: string;
        subject: string;
        issuedAt?: number;
        expiresAt?: number;
      }>
    >
  >;
}

export interface AuthProxyPort {
  verify(
    input: Readonly<{
      provider: Readonly<{ issuer: string; audience: string }>;
      assertion: string;
      provenance: VerifiedProxyProvenance;
    }>,
  ): Promise<Result<Readonly<{ issuer: string; subject: string }>>>;
}

function error(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

export function createAuthProxyProvenanceVerifier(
  dependencies: Readonly<{
    database: Database;
    clock: () => number;
    directPeers: readonly string[];
    forwardedOrigin: string;
    issuer: string;
    audience: string;
    assertions: AuthProxyAssertionPort;
  }>,
) {
  return {
    async verify(
      input: Readonly<{
        directPeer: string;
        forwardedOrigin: string;
        assertion: string;
        replayKey: string;
      }>,
    ): Promise<Result<VerifiedProviderIdentity>> {
      if (
        !dependencies.directPeers.includes(input.directPeer) ||
        input.forwardedOrigin !== dependencies.forwardedOrigin ||
        input.assertion.length < 1 ||
        input.assertion.length > 16_384 ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.replayKey)
      )
        return error(
          "AUTH_PROXY_PROVENANCE_INVALID",
          "Authentication proxy provenance is invalid.",
        );
      const replayHash = createHash("sha256")
        .update(`${dependencies.issuer}:${input.replayKey}`, "utf8")
        .digest("hex");
      if (
        dependencies.database
          .query<{ replay_hash: Uint8Array }, [Uint8Array, number]>(
            "SELECT replay_hash FROM auth_proxy_replays WHERE replay_hash = ? AND expires_at > ?",
          )
          .get(Buffer.from(replayHash, "hex"), dependencies.clock())
      )
        return error("AUTH_PROXY_REPLAY", "Authentication proxy assertion was already used.");
      const provenance = {
        directPeer: input.directPeer,
        forwardedOrigin: input.forwardedOrigin,
        verifiedAt: dependencies.clock(),
      } as VerifiedProxyProvenance;
      let assertion: Awaited<ReturnType<AuthProxyAssertionPort["verify"]>>;
      try {
        assertion = await dependencies.assertions.verify({
          assertion: input.assertion,
          issuer: dependencies.issuer,
          audience: dependencies.audience,
          provenance,
        });
      } catch {
        return error("AUTH_PROXY_ASSERTION_INVALID", "Authentication proxy assertion is invalid.");
      }
      const now = dependencies.clock();
      if (
        !assertion.ok ||
        assertion.value.issuer !== dependencies.issuer ||
        assertion.value.audience !== dependencies.audience ||
        assertion.value.subject.length < 1 ||
        assertion.value.subject.length > 512 ||
        (assertion.value.issuedAt !== undefined && assertion.value.issuedAt > now + 300) ||
        (assertion.value.expiresAt !== undefined && assertion.value.expiresAt <= now)
      )
        return error("AUTH_PROXY_ASSERTION_INVALID", "Authentication proxy assertion is invalid.");
      try {
        return inImmediateTransaction(dependencies.database, () => {
          dependencies.database
            .query("DELETE FROM auth_proxy_replays WHERE expires_at <= ?")
            .run(now);
          const inserted = dependencies.database
            .query(
              "INSERT OR IGNORE INTO auth_proxy_replays(replay_hash, issuer, expires_at, created_at) VALUES (?, ?, ?, ?)",
            )
            .run(
              Buffer.from(replayHash, "hex"),
              dependencies.issuer,
              Math.min(assertion.value.expiresAt ?? now + 600, now + 600),
              now,
            );
          return inserted.changes === 1
            ? {
                ok: true,
                value: {
                  kind: "AUTH_PROXY",
                  issuer: assertion.value.issuer,
                  subject: assertion.value.subject,
                } as VerifiedProviderIdentity,
              }
            : error("AUTH_PROXY_REPLAY", "Authentication proxy assertion was already used.");
        });
      } catch {
        return error("AUTH_PROXY_ASSERTION_INVALID", "Authentication proxy assertion is invalid.");
      }
    },
  };
}
