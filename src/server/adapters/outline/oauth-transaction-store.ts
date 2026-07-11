import type { Database } from "bun:sqlite";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import type { OutlineOAuthTransactionStore } from "./oauth.ts";

const denied = (code: string): Result<never> => ({
  ok: false,
  error: { code, message: "Outline OAuth transaction is unavailable.", retry: "NEVER" },
});

/** Keeps PKCE verifiers in the encrypted credential service while binding metadata in SQLite. */
export function createSqliteOutlineOAuthTransactionStore(
  dependencies: Readonly<{
    database: Database;
    saveVerifier(
      transactionId: string,
      connectorId: string,
      memberId: string,
      verifier: string,
    ): Result<Readonly<{ credentialId: string }>>;
    loadVerifier(credentialId: string): Result<string>;
  }>,
): OutlineOAuthTransactionStore {
  return {
    async save(transaction) {
      const verifier = dependencies.saveVerifier(
        transaction.id,
        transaction.connectorId,
        transaction.memberId,
        transaction.verifier,
      );
      if (!verifier.ok) return verifier;
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const current = dependencies.database
            .query<{ epoch: number; review_state: string }, [string]>(
              "SELECT epoch,review_state FROM connector_epochs WHERE connector_id=?",
            )
            .get(transaction.connectorId);
          if (current?.epoch !== transaction.connectorEpoch || current.review_state !== "READY")
            return denied("CONNECTOR_AUTHORITY_DENIED");
          dependencies.database
            .query(
              `INSERT INTO outline_oauth_transactions(id,connector_id,connector_epoch,member_id,session_id,state_hash,
              redirect_origin_digest,pkce_challenge,pkce_method,verifier_credential_id,requested_scope_digest,
              expires_at,created_at,revision) VALUES(?,?,?,?,?,?,?,?,'S256',?,?,?,?,1)`,
            )
            .run(
              transaction.id,
              transaction.connectorId,
              transaction.connectorEpoch,
              transaction.memberId,
              transaction.sessionId,
              Buffer.from(transaction.stateHash, "hex"),
              transaction.redirectOriginDigest,
              transaction.challenge,
              verifier.value.credentialId,
              transaction.scopeDigest,
              transaction.expiresAt,
              transaction.expiresAt - 600_000,
            );
          return { ok: true, value: { saved: true as const } };
        });
      } catch {
        return denied("OUTLINE_OAUTH_TRANSACTION_FAILED");
      }
    },
    async consume(id, stateHash, now) {
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const row = dependencies.database
            .query<
              {
                id: string;
                connector_id: string;
                connector_epoch: number;
                member_id: string;
                session_id: string;
                redirect_origin_digest: string;
                pkce_challenge: string;
                verifier_credential_id: string;
                requested_scope_digest: string;
                expires_at: number;
              },
              [number, string, Uint8Array, number]
            >(
              `SELECT tx.id,tx.connector_id,tx.connector_epoch,tx.member_id,tx.session_id,tx.redirect_origin_digest,
              tx.pkce_challenge,tx.verifier_credential_id,tx.requested_scope_digest,tx.expires_at
             FROM outline_oauth_transactions tx JOIN members m ON m.id=tx.member_id AND m.status='ACTIVE'
             JOIN sessions s ON s.id=tx.session_id AND s.revoked_at IS NULL AND s.expires_at>?
             JOIN connector_epochs e ON e.connector_id=tx.connector_id AND e.epoch=tx.connector_epoch AND e.review_state='READY'
             WHERE tx.id=? AND tx.state_hash=? AND tx.consumed_at IS NULL AND tx.revoked_at IS NULL AND tx.expires_at>?`,
            )
            .get(now, id, Buffer.from(stateHash, "hex"), now);
          if (!row) return denied("OUTLINE_OAUTH_TRANSACTION_INVALID");
          const verifier = dependencies.loadVerifier(row.verifier_credential_id);
          if (!verifier.ok) return verifier;
          const changed = dependencies.database
            .query(
              "UPDATE outline_oauth_transactions SET consumed_at=?,revision=revision+1 WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL",
            )
            .run(now, id);
          if (changed.changes !== 1) return denied("OUTLINE_OAUTH_TRANSACTION_INVALID");
          return {
            ok: true,
            value: {
              id: row.id,
              connectorId: row.connector_id,
              connectorEpoch: row.connector_epoch,
              memberId: row.member_id,
              sessionId: row.session_id,
              stateHash,
              redirectOriginDigest: row.redirect_origin_digest,
              verifier: verifier.value,
              challenge: row.pkce_challenge,
              scopeDigest: row.requested_scope_digest,
              expiresAt: row.expires_at,
            },
          };
        });
      } catch {
        return denied("OUTLINE_OAUTH_TRANSACTION_FAILED");
      }
    },
  };
}
