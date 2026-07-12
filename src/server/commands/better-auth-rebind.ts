import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { Result } from "../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../db/transaction.ts";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export function createBetterAuthRebindCommand(
  input: Readonly<{
    database: Database;
    invocationMode: "OFFLINE_CONTAINER";
    mountedBootstrapSecret: string;
    publicBaseUrl: string;
    clock: () => number;
    id: (prefix: string) => string;
    randomSecret?: () => string;
  }>,
) {
  if (input.invocationMode !== "OFFLINE_CONTAINER" || input.mountedBootstrapSecret.length < 32)
    throw new Error("AUTH_REBIND_CONFIGURATION_INVALID");
  const randomSecret = input.randomSecret ?? (() => randomBytes(32).toString("base64url"));
  return {
    generate(
      request: Readonly<{ memberId: string }>,
    ): Result<Readonly<{ memberId: string; recoveryUrl: string; expiresAt: number }>> {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(request.memberId))
        return {
          ok: false,
          error: {
            code: "AUTH_REBIND_OWNER_INVALID",
            message: "Passkey rebind owner is invalid.",
            retry: "NEVER",
          },
        };
      const owner = input.database
        .query<{ display_name: string; auth_user_id: string }, [string]>(
          `SELECT members.display_name, links.auth_user_id
           FROM members JOIN auth_member_links AS links ON links.member_id = members.id
           WHERE members.id = ? AND members.role = 'OWNER' AND members.status = 'ACTIVE'
             AND links.revoked_at IS NULL`,
        )
        .get(request.memberId);
      if (!owner)
        return {
          ok: false,
          error: {
            code: "AUTH_REBIND_OWNER_INVALID",
            message: "Passkey rebind owner is invalid.",
            retry: "NEVER",
          },
        };
      const context = randomSecret();
      const now = input.clock();
      try {
        return inImmediateTransaction(input.database, () => {
          input.database
            .query(
              `DELETE FROM auth_registration_tickets
               WHERE intended_member_id = ? AND purpose = 'HOST_RECOVERY' AND state != 'CONSUMED'`,
            )
            .run(request.memberId);
          input.database
            .query(
              `INSERT INTO auth_registration_tickets(
                 id, secret_hash, auth_user_id, intended_member_id, display_name,
                 purpose, state, created_at, expires_at
               ) VALUES (?, ?, ?, ?, ?, 'HOST_RECOVERY', 'PENDING', ?, ?)`,
            )
            .run(
              input.id("auth_registration"),
              digest(context),
              owner.auth_user_id,
              request.memberId,
              owner.display_name,
              now,
              now + 600,
            );
          input.database
            .query(
              `INSERT INTO audit_events(
                 id, kind, actor_kind, actor_id, subject_id, safe_details, created_at
               ) VALUES (?, 'HOST_RECOVERY_GENERATED', 'HOST', 'CONTAINER', ?, ?, ?)`,
            )
            .run(
              input.id("audit"),
              request.memberId,
              JSON.stringify({
                disposition: "GENERATED",
                expiresInSeconds: 600,
              }),
              now,
            );
          const recoveryUrl = new URL("/recover", input.publicBaseUrl);
          recoveryUrl.hash = context;
          return {
            ok: true,
            value: {
              memberId: request.memberId,
              recoveryUrl: recoveryUrl.toString(),
              expiresAt: now + 600,
            },
          };
        });
      } catch {
        return {
          ok: false,
          error: {
            code: "AUTH_REBIND_FAILED",
            message: "Passkey rebind failed.",
            retry: "NEVER",
          },
        };
      }
    },
  };
}
