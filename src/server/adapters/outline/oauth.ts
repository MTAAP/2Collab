import { createHash, randomBytes } from "node:crypto";
import type { Result } from "../../../shared/contracts/result.ts";
import type { OutlineOAuthProviderPort } from "./oauth-provider-contract.ts";

type Transaction = Readonly<{
  id: string;
  connectorId: string;
  memberId: string;
  sessionId: string;
  stateHash: string;
  redirectOriginDigest: string;
  verifier: string;
  challenge: string;
  scopeDigest: string;
  connectorEpoch: number;
  expiresAt: number;
}>;

export interface OutlineOAuthTransactionStore {
  save(transaction: Transaction): Promise<Result<Readonly<{ saved: true }>>>;
  consume(id: string, stateHash: string, now: number): Promise<Result<Transaction>>;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const base64urlDigest = (value: string) =>
  createHash("sha256").update(value).digest().toString("base64url");

export function createOutlineOAuth(
  dependencies: Readonly<{
    provider: OutlineOAuthProviderPort;
    transactions: OutlineOAuthTransactionStore;
    clock: () => number;
    id: () => string;
    random?: () => string;
  }>,
) {
  return {
    async begin(
      input: Readonly<{
        connectorId: string;
        connectorEpoch: number;
        memberId: string;
        sessionId: string;
        redirectOrigin: string;
        scopes: readonly string[];
      }>,
    ): Promise<Result<Readonly<{ transactionId: string; state: string; pkceChallenge: string }>>> {
      const verifier = dependencies.random?.() ?? randomBytes(32).toString("base64url");
      const state = dependencies.random?.() ?? randomBytes(32).toString("base64url");
      if (verifier.length < 43 || verifier.length > 128 || state.length < 32) {
        return {
          ok: false,
          error: {
            code: "OUTLINE_OAUTH_FAILED",
            message: "Outline OAuth could not start.",
            retry: "SAME_INPUT",
          },
        };
      }
      const transaction: Transaction = {
        id: dependencies.id(),
        connectorId: input.connectorId,
        connectorEpoch: input.connectorEpoch,
        memberId: input.memberId,
        sessionId: input.sessionId,
        stateHash: digest(state),
        redirectOriginDigest: digest(input.redirectOrigin),
        verifier,
        challenge: base64urlDigest(verifier),
        scopeDigest: digest([...input.scopes].sort().join("\n")),
        expiresAt: dependencies.clock() + 600_000,
      };
      const saved = await dependencies.transactions.save(transaction);
      return saved.ok
        ? {
            ok: true,
            value: { transactionId: transaction.id, state, pkceChallenge: transaction.challenge },
          }
        : saved;
    },

    async finish(
      input: Readonly<{
        transactionId: string;
        state: string;
        authorizationCode: string;
        connectorId: string;
        connectorEpoch: number;
        memberId: string;
        sessionId: string;
        redirectOrigin: string;
      }>,
    ) {
      const transaction = await dependencies.transactions.consume(
        input.transactionId,
        digest(input.state),
        dependencies.clock(),
      );
      if (!transaction.ok) return transaction;
      const expected = transaction.value;
      if (
        expected.connectorId !== input.connectorId ||
        expected.connectorEpoch !== input.connectorEpoch ||
        expected.memberId !== input.memberId ||
        expected.sessionId !== input.sessionId ||
        expected.redirectOriginDigest !== digest(input.redirectOrigin)
      ) {
        return {
          ok: false as const,
          error: {
            code: "OUTLINE_OAUTH_BINDING_INVALID",
            message: "Outline OAuth binding changed.",
            retry: "NEVER" as const,
          },
        };
      }
      return dependencies.provider.exchange(
        {
          connectorId: expected.connectorId,
          memberId: expected.memberId,
          sessionId: expected.sessionId,
          redirectOriginDigest: expected.redirectOriginDigest,
          pkceVerifier: expected.verifier,
          requestedScopeDigest: expected.scopeDigest,
        },
        input.authorizationCode,
      );
    },
  };
}
