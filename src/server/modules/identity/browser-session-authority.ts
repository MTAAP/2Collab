import type { Database } from "bun:sqlite";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { Result } from "../../../shared/contracts/result.ts";

export type BrowserSessionRequirement = Readonly<{
  role?: "OWNER";
  freshPasskey?: FreshPasskeyAuthorityFacts;
}>;

export type FreshPasskeyAuthorityFacts = Readonly<{
  memberId: string;
  challengeId: string;
  challengeRevision: number;
  credentialId: string;
  credentialRevision: number;
  verifiedAt: number;
  maximumAgeSeconds: number;
}>;

export type BrowserSessionAuthorityFacts = Readonly<{
  sessionId: string;
  memberId: string;
  role: "OWNER" | "MEMBER";
  authorityEpoch: number;
  memberRevision: number;
  sessionRevision: number;
  proofHash: Uint8Array;
  csrfHash: Uint8Array;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
}>;

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  digest: (value: string) => Promise<Uint8Array>;
}>;

function denied(): Result<never> {
  return {
    ok: false,
    error: {
      code: "SESSION_INVALID",
      message: "Member session is invalid.",
      retry: "NEVER",
    },
  };
}

/**
 * The single browser-session authority seam used by privileged server commands.
 * `authorize` captures all authority facts and `revalidate` must be called inside
 * the command's write transaction immediately before the protected mutation.
 */
export function createBrowserSessionAuthority(dependencies: Dependencies) {
  const select = `SELECT sessions.id AS session_id, members.id AS member_id, members.role,
                         members.authority_epoch, members.revision AS member_revision,
                         sessions.revision AS session_revision, sessions.proof_hash,
                         sessions.csrf_hash, sessions.idle_expires_at,
                         sessions.absolute_expires_at
                  FROM sessions JOIN members ON members.id = sessions.member_id
                  WHERE sessions.id = ? AND members.id = ? AND sessions.proof_hash = ?
                    AND sessions.kind = 'BROWSER' AND sessions.revoked_at IS NULL
                    AND sessions.idle_expires_at > ? AND sessions.absolute_expires_at > ?
                    AND members.status = 'ACTIVE'
                    AND sessions.member_authority_epoch = members.authority_epoch`;

  return {
    async authorize(
      actor: MemberActor,
      requirement: BrowserSessionRequirement = {},
    ): Promise<Result<BrowserSessionAuthorityFacts>> {
      if (actor.sessionProof.length < 32 || actor.sessionProof.length > 512) return denied();
      const proofHash = await dependencies.digest(actor.sessionProof);
      const now = dependencies.clock();
      const row = dependencies.database
        .query<
          {
            session_id: string;
            member_id: string;
            role: "OWNER" | "MEMBER";
            authority_epoch: number;
            member_revision: number;
            session_revision: number;
            proof_hash: Uint8Array;
            csrf_hash: Uint8Array;
            idle_expires_at: number;
            absolute_expires_at: number;
          },
          [string, string, Uint8Array, number, number]
        >(select)
        .get(actor.sessionId, actor.memberId, proofHash, now, now);
      if (!row || (requirement.role !== undefined && row.role !== requirement.role))
        return denied();
      return {
        ok: true,
        value: {
          sessionId: row.session_id,
          memberId: row.member_id,
          role: row.role,
          authorityEpoch: row.authority_epoch,
          memberRevision: row.member_revision,
          sessionRevision: row.session_revision,
          proofHash: row.proof_hash,
          csrfHash: row.csrf_hash,
          idleExpiresAt: row.idle_expires_at,
          absoluteExpiresAt: row.absolute_expires_at,
        },
      };
    },

    revalidate(
      facts: BrowserSessionAuthorityFacts,
      requirement: BrowserSessionRequirement = {},
    ): Result<BrowserSessionAuthorityFacts> {
      const now = dependencies.clock();
      const row = dependencies.database
        .query<
          { role: "OWNER" | "MEMBER" },
          [string, string, Uint8Array, number, number, number, number, number]
        >(
          `${select}
             AND members.revision = ? AND sessions.revision = ?
             AND members.authority_epoch = ?`,
        )
        .get(
          facts.sessionId,
          facts.memberId,
          facts.proofHash,
          now,
          now,
          facts.memberRevision,
          facts.sessionRevision,
          facts.authorityEpoch,
        );
      if (!row || (requirement.role !== undefined && row.role !== requirement.role))
        return denied();
      const fresh = requirement.freshPasskey;
      if (fresh) {
        if (
          fresh.memberId !== facts.memberId ||
          !Number.isInteger(fresh.verifiedAt) ||
          !Number.isInteger(fresh.maximumAgeSeconds) ||
          fresh.maximumAgeSeconds < 1 ||
          fresh.maximumAgeSeconds > 300 ||
          now < fresh.verifiedAt ||
          now - fresh.verifiedAt >= fresh.maximumAgeSeconds
        )
          return denied();
        const parameters: [string, string, string, number, number, string, number] = [
          fresh.credentialId,
          fresh.challengeId,
          fresh.memberId,
          fresh.challengeRevision,
          now,
          fresh.credentialId,
          fresh.credentialRevision,
        ];
        const current = dependencies.database
          .query<
            { challenge_id: string },
            [string, string, string, number, number, string, number]
          >(
            `SELECT challenges.id AS challenge_id
             FROM webauthn_challenges AS challenges
             JOIN passkey_credentials AS credentials
               ON credentials.id = ? AND credentials.member_id = challenges.member_id
             WHERE challenges.id = ? AND challenges.member_id = ?
               AND challenges.purpose = 'PRIVILEGED_REAUTHENTICATION'
               AND challenges.revision = ? AND challenges.consumed_at IS NULL
               AND challenges.revoked_at IS NULL AND challenges.expires_at > ?
               AND credentials.id = ? AND credentials.revision = ?
               AND credentials.revoked_at IS NULL`,
          )
          .get(...parameters);
        if (!current) return denied();
      }
      return { ok: true, value: facts };
    },
  };
}
