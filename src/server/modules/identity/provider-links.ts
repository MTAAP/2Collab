import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import type { VerifiedProviderIdentity } from "./oidc.ts";

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
  digest: (value: string) => Promise<Uint8Array>;
}>;

export type ProviderLink = Readonly<{
  id: string;
  memberId: string;
  kind: "OIDC" | "AUTH_PROXY";
  issuer: string;
  revision: number;
}>;

function error(
  code: string,
  message: string,
  retry: "NEVER" | "SAME_INPUT" = "NEVER",
): Result<never> {
  return { ok: false, error: { code, message, retry } };
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function inputHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function createProviderLinkAuthority(dependencies: Dependencies) {
  const activeActor = async (actor: MemberActor) => {
    if (actor.sessionProof.length < 32 || actor.sessionProof.length > 512) return null;
    const proofHash = await dependencies.digest(actor.sessionProof);
    return dependencies.database
      .query<
        { member_revision: number; session_revision: number },
        [string, string, Uint8Array, number]
      >(
        `SELECT members.revision AS member_revision, sessions.revision AS session_revision
         FROM members JOIN sessions ON sessions.member_id = members.id
         WHERE members.id = ? AND sessions.id = ? AND sessions.proof_hash = ?
           AND members.status = 'ACTIVE' AND sessions.kind = 'BROWSER'
           AND sessions.revoked_at IS NULL AND sessions.expires_at > ?
           AND sessions.member_authority_epoch = members.authority_epoch`,
      )
      .get(actor.memberId, actor.sessionId, proofHash, dependencies.clock());
  };

  const validateIdentity = (identity: VerifiedProviderIdentity): boolean =>
    (identity.kind === "OIDC" || identity.kind === "AUTH_PROXY") &&
    identity.issuer.length > 0 &&
    identity.issuer.length <= 512 &&
    identity.subject.length > 0 &&
    identity.subject.length <= 512;

  return {
    async link(
      input: Readonly<{
        idempotencyKey: string;
        actor: MemberActor;
        identity: VerifiedProviderIdentity;
      }>,
    ): Promise<Result<ProviderLink>> {
      if (!validId(input.idempotencyKey) || !validateIdentity(input.identity))
        return error("PROVIDER_IDENTITY_INVALID", "Provider identity is invalid.");
      const authority = await activeActor(input.actor);
      if (!authority) return error("SESSION_INVALID", "Member session is invalid.");
      const hash = inputHash({
        memberId: input.actor.memberId,
        kind: input.identity.kind,
        issuer: input.identity.issuer,
        subject: input.identity.subject,
      });
      const stored = dependencies.database
        .query<{ input_hash: string; result_json: string }, [string, string]>(
          "SELECT input_hash, result_json FROM idempotency_results WHERE actor_id = ? AND idempotency_key = ?",
        )
        .get(`PROVIDER_${input.actor.memberId}`, input.idempotencyKey);
      if (stored) {
        if (stored.input_hash !== hash)
          return error("IDEMPOTENCY_CONFLICT", "Idempotency key was used with different input.");
        try {
          return { ok: true, value: JSON.parse(stored.result_json) as ProviderLink };
        } catch {
          return error("IDEMPOTENCY_STORAGE_INVALID", "Stored idempotency result is invalid.");
        }
      }
      const existing = dependencies.database
        .query<{ id: string; member_id: string; revision: number }, [string, string, string]>(
          "SELECT id, member_id, revision FROM member_credentials WHERE kind = ? AND issuer = ? AND subject = ? AND revoked_at IS NULL",
        )
        .get(input.identity.kind, input.identity.issuer, input.identity.subject);
      if (existing && existing.member_id !== input.actor.memberId)
        return error("PROVIDER_IDENTITY_ALREADY_LINKED", "Provider identity is already linked.");
      const credentialId = dependencies.id("provider_identity");
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const current = dependencies.database
            .query<{ id: string }, [string, number, string, number]>(
              `SELECT members.id FROM members JOIN sessions ON sessions.member_id = members.id
               WHERE members.id = ? AND members.revision = ? AND members.status = 'ACTIVE'
                 AND sessions.id = ? AND sessions.revision = ? AND sessions.revoked_at IS NULL`,
            )
            .get(
              input.actor.memberId,
              authority.member_revision,
              input.actor.sessionId,
              authority.session_revision,
            );
          if (!current)
            return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
          if (!existing) {
            dependencies.database
              .query(
                `INSERT INTO member_credentials(
                   id, member_id, kind, issuer, subject, revision, created_at
                 ) VALUES (?, ?, ?, ?, ?, 1, ?)`,
              )
              .run(
                credentialId,
                input.actor.memberId,
                input.identity.kind,
                input.identity.issuer,
                input.identity.subject,
                dependencies.clock(),
              );
          }
          const value: ProviderLink = {
            id: existing?.id ?? credentialId,
            memberId: input.actor.memberId,
            kind: input.identity.kind,
            issuer: input.identity.issuer,
            revision: existing?.revision ?? 1,
          };
          dependencies.database
            .query(
              "INSERT INTO idempotency_results(actor_id, idempotency_key, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
              `PROVIDER_${input.actor.memberId}`,
              input.idempotencyKey,
              hash,
              JSON.stringify(value),
              dependencies.clock(),
            );
          dependencies.database
            .query(
              "INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at) VALUES (?, 'PROVIDER_IDENTITY_LINKED', 'MEMBER', ?, ?, ?, ?)",
            )
            .run(
              dependencies.id("audit"),
              input.actor.memberId,
              credentialId,
              JSON.stringify({ providerKind: input.identity.kind, disposition: "LINKED" }),
              dependencies.clock(),
            );
          return { ok: true, value };
        });
      } catch {
        return error("PROVIDER_LINK_FAILED", "Provider identity link failed.");
      }
    },

    async acceptInvitation(
      input: Readonly<{
        idempotencyKey: string;
        invitationSessionSecret: string;
        displayName: string;
        identity: VerifiedProviderIdentity;
      }>,
    ): Promise<Result<ProviderLink>> {
      if (
        !validId(input.idempotencyKey) ||
        input.invitationSessionSecret.length < 32 ||
        input.invitationSessionSecret.length > 512 ||
        input.displayName.trim().length < 1 ||
        input.displayName.length > 120 ||
        !validateIdentity(input.identity)
      )
        return error("INVITATION_REQUIRED", "A valid invitation is required.");
      const sessionHash = await dependencies.digest(input.invitationSessionSecret);
      const exchange = dependencies.database
        .query<
          Readonly<{
            exchange_id: string;
            exchange_revision: number;
            invitation_id: string;
            invitation_revision: number;
            expires_at: number;
          }>,
          [Uint8Array, number, number]
        >(
          `SELECT exchange.id AS exchange_id, exchange.revision AS exchange_revision,
                  invitations.id AS invitation_id, invitations.revision AS invitation_revision,
                  exchange.expires_at
           FROM invitation_exchange_sessions AS exchange
           JOIN invitations ON invitations.id = exchange.invitation_id
           WHERE exchange.session_hash = ? AND exchange.consumed_at IS NULL
             AND exchange.revoked_at IS NULL AND exchange.expires_at > ?
             AND invitations.consumed_at IS NULL AND invitations.revoked_at IS NULL
             AND invitations.expires_at > ?`,
        )
        .get(sessionHash, dependencies.clock(), dependencies.clock());
      if (!exchange) return error("INVITATION_REQUIRED", "A valid invitation is required.");
      if (
        dependencies.database
          .query<{ id: string }, [string, string, string]>(
            "SELECT id FROM member_credentials WHERE kind = ? AND issuer = ? AND subject = ? AND revoked_at IS NULL",
          )
          .get(input.identity.kind, input.identity.issuer, input.identity.subject)
      )
        return error("PROVIDER_IDENTITY_ALREADY_LINKED", "Provider identity is already linked.");
      const memberId = dependencies.id("member");
      const credentialId = dependencies.id("provider_identity");
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const consumedExchange = dependencies.database
            .query(
              `UPDATE invitation_exchange_sessions SET consumed_at = ?, revision = revision + 1
               WHERE id = ? AND revision = ? AND consumed_at IS NULL AND revoked_at IS NULL
                 AND expires_at > ?`,
            )
            .run(
              dependencies.clock(),
              exchange.exchange_id,
              exchange.exchange_revision,
              dependencies.clock(),
            );
          const consumedInvitation = dependencies.database
            .query(
              `UPDATE invitations SET consumed_at = ?, revision = revision + 1
               WHERE id = ? AND revision = ? AND consumed_at IS NULL AND revoked_at IS NULL
                 AND expires_at > ?`,
            )
            .run(
              dependencies.clock(),
              exchange.invitation_id,
              exchange.invitation_revision,
              dependencies.clock(),
            );
          if (consumedExchange.changes !== 1 || consumedInvitation.changes !== 1)
            return error("INVITATION_REQUIRED", "A valid invitation is required.");
          dependencies.database
            .query(
              "INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at) VALUES (?, ?, 'MEMBER', 'ACTIVE', 1, 1, ?)",
            )
            .run(memberId, input.displayName.trim(), dependencies.clock());
          dependencies.database
            .query(
              "INSERT INTO member_credentials(id, member_id, kind, issuer, subject, revision, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
            )
            .run(
              credentialId,
              memberId,
              input.identity.kind,
              input.identity.issuer,
              input.identity.subject,
              dependencies.clock(),
            );
          const value: ProviderLink = {
            id: credentialId,
            memberId,
            kind: input.identity.kind,
            issuer: input.identity.issuer,
            revision: 1,
          };
          dependencies.database
            .query(
              "INSERT INTO idempotency_results(actor_id, idempotency_key, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
              `INVITATION_${exchange.invitation_id}`,
              input.idempotencyKey,
              inputHash({
                invitationId: exchange.invitation_id,
                kind: input.identity.kind,
                issuer: input.identity.issuer,
                subject: input.identity.subject,
              }),
              JSON.stringify(value),
              dependencies.clock(),
            );
          return { ok: true, value };
        });
      } catch {
        return error("PROVIDER_LINK_FAILED", "Provider identity link failed.");
      }
    },
  };
}
