import type { Database } from "bun:sqlite";
import type { Result } from "../../../shared/contracts/result.ts";

export type OutlineIdentityRequest = Readonly<{
  operation: "HUMAN_WRITE" | "AGENT_OPERATION" | "READ";
  connectorId: string;
  memberId?: string;
  runId?: string;
  attemptId?: string;
}>;

export type OutlineIdentity =
  | Readonly<{
      kind: "MEMBER";
      connectorId: string;
      memberId: string;
      outlineUserId: string;
      grantRevision: number;
    }>
  | Readonly<{
      kind: "BOT";
      connectorId: string;
      providerUserId: string;
      runId?: string;
      attemptId?: string;
    }>;

function denied(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message, retry: "EXPLICIT_RESUME" } };
}

export function createOutlineIdentityResolver(
  database: Database,
  dependencies: Readonly<{ clock: () => number }> = { clock: () => Date.now() },
) {
  return {
    resolve(request: OutlineIdentityRequest): Result<OutlineIdentity> {
      if (request.operation === "HUMAN_WRITE") {
        if (!request.memberId)
          return denied("OUTLINE_MEMBER_GRANT_REQUIRED", "A delegated member grant is required.");
        const row = database
          .query<{ outline_user_id: string; revision: number }, [string, string, number]>(
            `SELECT grant.outline_user_id, grant.revision
             FROM outline_member_oauth_grants AS grant
             JOIN members AS member ON member.id = grant.member_id
             JOIN encrypted_credentials AS credential ON credential.id = grant.credential_id
             JOIN connector_epochs AS epoch ON epoch.connector_id = grant.connector_id
             WHERE grant.connector_id = ? AND grant.member_id = ?
               AND member.status = 'ACTIVE'
               AND grant.refresh_status = 'READY' AND grant.revoked_at IS NULL
               AND grant.access_expires_at > ?
               AND credential.revoked_at IS NULL
               AND credential.revision = grant.credential_revision
               AND epoch.review_state = 'READY'`,
          )
          .get(request.connectorId, request.memberId, dependencies.clock());
        if (!row)
          return denied("OUTLINE_MEMBER_GRANT_REQUIRED", "A delegated member grant is required.");
        return {
          ok: true,
          value: {
            kind: "MEMBER",
            connectorId: request.connectorId,
            memberId: request.memberId,
            outlineUserId: row.outline_user_id,
            grantRevision: row.revision,
          },
        };
      }
      const bot = database
        .query<{ bot_provider_user_id: string }, [string]>(
          `SELECT connection.bot_provider_user_id
           FROM outline_connections AS connection
           JOIN encrypted_credentials AS credential
             ON credential.id = connection.bot_credential_id AND credential.revoked_at IS NULL
           JOIN connector_epochs AS epoch
             ON epoch.connector_id = connection.connector_id AND epoch.review_state = 'READY'
           WHERE connection.connector_id = ?`,
        )
        .get(request.connectorId);
      if (!bot) return denied("OUTLINE_BOT_REQUIRED", "The Outline bot identity is unavailable.");
      if (request.operation === "AGENT_OPERATION" && (!request.runId || !request.attemptId)) {
        return denied("RUN_AUTHORITY_REQUIRED", "Run authority is required.");
      }
      return {
        ok: true,
        value: {
          kind: "BOT",
          connectorId: request.connectorId,
          providerUserId: bot.bot_provider_user_id,
          runId: request.runId,
          attemptId: request.attemptId,
        },
      };
    },
  };
}
