import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";

const OIDC_TRANSACTION_SECONDS = 10 * 60;
declare const verifiedProviderIdentityBrand: unique symbol;

export type VerifiedProviderIdentity = Readonly<{
  kind: "OIDC" | "AUTH_PROXY";
  issuer: string;
  subject: string;
  [verifiedProviderIdentityBrand]: true;
}>;

export type StoredOidcProvider = Readonly<{
  id: string;
  issuer: string;
  audience: string;
  clientId: string;
  redirectUri: string;
}>;

export type StoredOidcTransaction = Readonly<{
  id: string;
  providerId: string;
  stateHash: Uint8Array;
  nonceHash: Uint8Array;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}>;

export interface OidcPort {
  verify(
    input: Readonly<{
      transaction: StoredOidcTransaction;
      provider: StoredOidcProvider;
      authorizationCode: string;
      returnedState: string;
    }>,
  ): Promise<Result<Readonly<{ issuer: string; subject: string }>>>;
}

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
  randomSecret?: (label: "state" | "nonce") => string;
  providers: readonly StoredOidcProvider[];
  port: OidcPort;
}>;

type TransactionRow = Readonly<{
  id: string;
  provider_id: string;
  state_hash: Uint8Array;
  nonce_hash: Uint8Array;
  redirect_uri: string;
  revision: number;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}>;

function error(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

function digest(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function validProvider(provider: StoredOidcProvider): boolean {
  try {
    const issuer = new URL(provider.issuer);
    const redirect = new URL(provider.redirectUri);
    return (
      issuer.protocol === "https:" &&
      issuer.origin === provider.issuer &&
      redirect.protocol === "https:" &&
      provider.id.length > 0 &&
      provider.id.length <= 128 &&
      provider.audience.length > 0 &&
      provider.audience.length <= 256 &&
      provider.clientId.length > 0 &&
      provider.clientId.length <= 256
    );
  } catch {
    return false;
  }
}

export function createOidcAuthority(dependencies: Dependencies) {
  if (
    dependencies.providers.length < 1 ||
    dependencies.providers.some((item) => !validProvider(item))
  )
    throw new Error("OIDC_CONFIGURATION_INVALID");
  const randomSecret = dependencies.randomSecret ?? (() => randomBytes(32).toString("base64url"));
  const providerById = new Map(dependencies.providers.map((provider) => [provider.id, provider]));
  return {
    begin(input: Readonly<{ providerId: string }>): Result<
      Readonly<{
        transactionId: string;
        state: string;
        nonce: string;
        redirectUri: string;
        expiresAt: number;
      }>
    > {
      const provider = providerById.get(input.providerId);
      if (!provider) return error("OIDC_PROVIDER_INVALID", "OIDC provider is invalid.");
      const state = randomSecret("state");
      const nonce = randomSecret("nonce");
      if (state.length < 6 || nonce.length < 6)
        return error("OIDC_OPERATION_FAILED", "OIDC operation failed.");
      const id = dependencies.id("oidc_transaction");
      const now = dependencies.clock();
      try {
        return inImmediateTransaction(dependencies.database, () => {
          dependencies.database
            .query(
              `INSERT INTO oidc_transactions(
                 id, provider_id, state_hash, nonce_hash, redirect_uri,
                 revision, created_at, expires_at
               ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              id,
              provider.id,
              digest(state),
              digest(nonce),
              provider.redirectUri,
              now,
              now + OIDC_TRANSACTION_SECONDS,
            );
          return {
            ok: true,
            value: {
              transactionId: id,
              state,
              nonce,
              redirectUri: provider.redirectUri,
              expiresAt: now + OIDC_TRANSACTION_SECONDS,
            },
          };
        });
      } catch {
        return error("OIDC_OPERATION_FAILED", "OIDC operation failed.");
      }
    },

    async complete(
      input: Readonly<{ transactionId: string; authorizationCode: string; returnedState: string }>,
    ): Promise<Result<VerifiedProviderIdentity>> {
      if (
        input.transactionId.length < 1 ||
        input.transactionId.length > 128 ||
        input.authorizationCode.length < 1 ||
        input.authorizationCode.length > 8_192 ||
        input.returnedState.length < 1 ||
        input.returnedState.length > 512
      )
        return error("OIDC_VERIFICATION_FAILED", "OIDC verification failed.");
      const row = dependencies.database
        .query<TransactionRow, [string]>("SELECT * FROM oidc_transactions WHERE id = ?")
        .get(input.transactionId);
      if (!row) return error("OIDC_TRANSACTION_INVALID", "OIDC transaction is invalid.");
      if (row.consumed_at !== null)
        return error("OIDC_TRANSACTION_USED", "OIDC transaction was already used.");
      if (dependencies.clock() >= row.expires_at)
        return error("OIDC_TRANSACTION_EXPIRED", "OIDC transaction expired.");
      if (!safeEqual(row.state_hash, digest(input.returnedState)))
        return error("OIDC_VERIFICATION_FAILED", "OIDC verification failed.");
      const provider = providerById.get(row.provider_id);
      if (!provider || provider.redirectUri !== row.redirect_uri)
        return error("OIDC_CONFIGURATION_STALE", "OIDC provider configuration changed.");
      let verified: Result<Readonly<{ issuer: string; subject: string }>>;
      try {
        verified = await dependencies.port.verify({
          transaction: {
            id: row.id,
            providerId: row.provider_id,
            stateHash: row.state_hash,
            nonceHash: row.nonce_hash,
            redirectUri: row.redirect_uri,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
          },
          provider,
          authorizationCode: input.authorizationCode,
          returnedState: input.returnedState,
        });
      } catch {
        return error("OIDC_VERIFICATION_FAILED", "OIDC verification failed.");
      }
      if (
        !verified.ok ||
        verified.value.issuer !== provider.issuer ||
        verified.value.subject.length < 1 ||
        verified.value.subject.length > 512
      )
        return error("OIDC_VERIFICATION_FAILED", "OIDC verification failed.");
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const consumed = dependencies.database
            .query(
              `UPDATE oidc_transactions SET consumed_at = ?, revision = revision + 1
               WHERE id = ? AND revision = ? AND consumed_at IS NULL AND expires_at > ?`,
            )
            .run(dependencies.clock(), row.id, row.revision, dependencies.clock());
          if (consumed.changes !== 1)
            return error("OIDC_TRANSACTION_USED", "OIDC transaction was already used.");
          return {
            ok: true,
            value: {
              kind: "OIDC",
              issuer: verified.value.issuer,
              subject: verified.value.subject,
            } as VerifiedProviderIdentity,
          };
        });
      } catch {
        return error("OIDC_OPERATION_FAILED", "OIDC operation failed.");
      }
    },
  };
}
