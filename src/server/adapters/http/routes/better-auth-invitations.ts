import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { ExchangeInvitationSecretSchema } from "../../../../shared/contracts/identity.ts";
import type { Result } from "../../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../../db/transaction.ts";
import { domainHttpStatus } from "../domain-results.ts";
import { parseBoundedJson } from "../middleware/request-limits.ts";

const Begin = z.object({ displayName: z.string().trim().min(1).max(120) }).strict();
const Complete = z.object({ registrationContext: z.string().min(32).max(512) }).strict();
const COOKIE = "collab_invitation";
const COOKIE_PATH = "/api/v1/invitations";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

type ExchangeInvitation = (
  input: z.infer<typeof ExchangeInvitationSecretSchema>,
) => Promise<Result<Readonly<{ invitationId: string; secret: string; expiresAt: number }>>>;

type ValidExchange = Readonly<{
  exchange_id: string;
  invitation_id: string;
  invitation_expires_at: number;
  exchange_expires_at: number;
  inviter_name: string;
}>;

export function createBetterAuthInvitationRoutes(
  input: Readonly<{
    database: Database;
    configuredOrigin: string;
    clock: () => number;
    id: (prefix: string) => string;
    exchangeInvitation: ExchangeInvitation;
  }>,
) {
  const app = new Hono();
  const secure = new URL(input.configuredOrigin).protocol === "https:";
  const invitationCookie = (context: Parameters<typeof getCookie>[0]) => getCookie(context, COOKIE);
  const validExchange = (secret: string | undefined): ValidExchange | null => {
    if (!secret || secret.length < 32 || secret.length > 512) return null;
    const now = input.clock();
    return input.database
      .query<ValidExchange, [Uint8Array, number, number]>(
        `SELECT exchange.id AS exchange_id, invitations.id AS invitation_id,
                invitations.expires_at AS invitation_expires_at,
                exchange.expires_at AS exchange_expires_at,
                members.display_name AS inviter_name
         FROM invitation_exchange_sessions AS exchange
         JOIN invitations ON invitations.id = exchange.invitation_id
         JOIN members ON members.id = invitations.inviter_id
         WHERE exchange.session_hash = ? AND exchange.consumed_at IS NULL
           AND exchange.revoked_at IS NULL AND exchange.expires_at > ?
           AND invitations.consumed_at IS NULL AND invitations.revoked_at IS NULL
           AND invitations.expires_at > ?`,
      )
      .get(digest(secret), now, now);
  };
  const mutationAllowed = (request: Request) =>
    request.headers.get("origin") === input.configuredOrigin &&
    request.headers.get("sec-fetch-site") === "same-origin" &&
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() === "application/json";
  const forbidden = (context: Parameters<typeof getCookie>[0]) =>
    context.json(
      { error: { code: "INVITATION_REQUIRED", message: "A valid invitation is required." } },
      403,
    );
  const audit = (
    kind: "INVITATION_AUTH_BEGUN" | "INVITATION_AUTH_COMPLETED",
    invitationId: string,
    subjectId: string,
  ) =>
    input.database
      .query(
        `INSERT INTO audit_events(
           id, kind, actor_kind, actor_id, subject_id, safe_details, created_at
         ) VALUES (?, ?, 'INVITATION', ?, ?, ?, ?)`,
      )
      .run(
        input.id("audit"),
        kind,
        invitationId,
        subjectId,
        JSON.stringify({ authentication: "PASSKEY", role: "MEMBER" }),
        input.clock(),
      );

  app.post("/invitations/exchange", async (context) => {
    if (!mutationAllowed(context.req.raw)) return forbidden(context);
    const parsed = await parseBoundedJson(context, ExchangeInvitationSecretSchema);
    if (parsed instanceof Response) return parsed;
    const result = await input.exchangeInvitation(parsed);
    if (!result.ok) return context.json(result, domainHttpStatus(result.error.code));
    setCookie(context, COOKIE, result.value.secret, {
      httpOnly: true,
      maxAge: 15 * 60,
      path: COOKIE_PATH,
      sameSite: "Strict",
      secure,
    });
    const exchange = validExchange(result.value.secret);
    if (!exchange) return forbidden(context);
    return context.json({
      ok: true,
      value: {
        invitationId: result.value.invitationId,
        expiresAt: result.value.expiresAt,
        invitation: {
          id: exchange.invitation_id,
          inviterDisplayName: exchange.inviter_name,
          role: "MEMBER" as const,
          expiresAt: exchange.invitation_expires_at,
        },
      },
    });
  });

  app.post("/invitations/auth/begin", async (context) => {
    if (!mutationAllowed(context.req.raw)) return forbidden(context);
    const exchange = validExchange(invitationCookie(context));
    if (!exchange) return forbidden(context);
    const parsed = await parseBoundedJson(context, Begin);
    if (parsed instanceof Response) return parsed;
    const registrationContext = randomBytes(32).toString("base64url");
    const memberId = input.id("member");
    const now = input.clock();
    const expiresAt = Math.min(
      exchange.exchange_expires_at,
      exchange.invitation_expires_at,
      now + 300,
    );
    try {
      inImmediateTransaction(input.database, () => {
        const previous = input.database
          .query<{ auth_user_id: string; has_passkey: number }, [string]>(
            `SELECT tickets.auth_user_id,
                    EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = tickets.auth_user_id)
                      AS has_passkey
             FROM auth_registration_tickets AS tickets
             WHERE tickets.invitation_exchange_session_id = ? AND tickets.consumed_at IS NULL`,
          )
          .get(exchange.exchange_id);
        if (previous?.has_passkey) throw new Error("INVITATION_AUTH_ALREADY_VERIFIED");
        if (previous)
          input.database.query("DELETE FROM auth_users WHERE id = ?").run(previous.auth_user_id);
        input.database
          .query(
            `INSERT INTO auth_users(id, name, email, emailVerified, createdAt, updatedAt)
             VALUES (?, ?, ?, 0, ?, ?)`,
          )
          .run(
            memberId,
            parsed.displayName,
            `${memberId}@identity.invalid`,
            now * 1_000,
            now * 1_000,
          );
        input.database
          .query(
            `INSERT INTO auth_registration_tickets(
               id, secret_hash, auth_user_id, intended_member_id,
               invitation_exchange_session_id, display_name, purpose, state, created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'INVITATION', 'PENDING', ?, ?)`,
          )
          .run(
            input.id("auth_registration"),
            digest(registrationContext),
            memberId,
            memberId,
            exchange.exchange_id,
            parsed.displayName,
            now,
            expiresAt,
          );
        audit("INVITATION_AUTH_BEGUN", exchange.invitation_id, memberId);
      });
      return context.json({
        ok: true,
        value: {
          registrationContext,
          memberId,
          expiresAt,
          invitation: {
            id: exchange.invitation_id,
            inviterDisplayName: exchange.inviter_name,
            role: "MEMBER" as const,
            expiresAt: exchange.invitation_expires_at,
          },
        },
      });
    } catch {
      return context.json(
        { error: { code: "INVITATION_AUTH_FAILED", message: "Invitation authentication failed." } },
        409,
      );
    }
  });

  app.post("/invitations/auth/complete", async (context) => {
    if (!mutationAllowed(context.req.raw)) return forbidden(context);
    const exchange = validExchange(invitationCookie(context));
    if (!exchange) return forbidden(context);
    const parsed = await parseBoundedJson(context, Complete);
    if (parsed instanceof Response) return parsed;
    const ticket = input.database
      .query<
        { id: string; auth_user_id: string; intended_member_id: string; display_name: string },
        [Uint8Array, string, number]
      >(
        `SELECT id, auth_user_id, intended_member_id, display_name
         FROM auth_registration_tickets
         WHERE secret_hash = ? AND invitation_exchange_session_id = ?
           AND purpose = 'INVITATION' AND state = 'PASSKEY_VERIFIED'
           AND consumed_at IS NULL AND expires_at > ?
           AND EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = auth_user_id)`,
      )
      .get(digest(parsed.registrationContext), exchange.exchange_id, input.clock());
    if (!ticket)
      return context.json(
        {
          error: {
            code: "INVITATION_AUTH_INVALID",
            message: "Invitation authentication is invalid.",
          },
        },
        400,
      );
    const now = input.clock();
    try {
      inImmediateTransaction(input.database, () => {
        const consumedTicket = input.database
          .query(
            `UPDATE auth_registration_tickets SET state = 'CONSUMED', consumed_at = ?
             WHERE id = ? AND state = 'PASSKEY_VERIFIED' AND consumed_at IS NULL AND expires_at > ?`,
          )
          .run(now, ticket.id, now);
        const consumedExchange = input.database
          .query(
            `UPDATE invitation_exchange_sessions SET consumed_at = ?, revision = revision + 1
             WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
          )
          .run(now, exchange.exchange_id, now);
        const consumedInvitation = input.database
          .query(
            `UPDATE invitations SET consumed_at = ?, revision = revision + 1
             WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
          )
          .run(now, exchange.invitation_id, now);
        if (
          consumedTicket.changes !== 1 ||
          consumedExchange.changes !== 1 ||
          consumedInvitation.changes !== 1
        )
          throw new Error("INVITATION_CAS_MISSED");
        input.database
          .query(
            `INSERT INTO members(
               id, display_name, role, status, authority_epoch, revision, created_at
             ) VALUES (?, ?, 'MEMBER', 'ACTIVE', 1, 1, ?)`,
          )
          .run(ticket.intended_member_id, ticket.display_name, now);
        input.database
          .query(
            `INSERT INTO auth_member_links(
               auth_user_id, member_id, authority_epoch_snapshot, created_at
             ) VALUES (?, ?, 1, ?)`,
          )
          .run(ticket.auth_user_id, ticket.intended_member_id, now);
        audit("INVITATION_AUTH_COMPLETED", exchange.invitation_id, ticket.intended_member_id);
      });
      deleteCookie(context, COOKIE, { path: COOKIE_PATH, secure });
      return context.json({
        ok: true,
        value: { memberId: ticket.intended_member_id, readyToSignIn: true as const },
      });
    } catch {
      return context.json(
        { error: { code: "INVITATION_AUTH_FAILED", message: "Invitation authentication failed." } },
        409,
      );
    }
  });

  return app;
}
