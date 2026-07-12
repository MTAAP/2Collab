import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { CollabEmailOtpPort } from "../../../modules/identity/better-auth.ts";
import { parseBoundedJson, type PublicRateLimitPort } from "../middleware/request-limits.ts";

const RequestOtp = z
  .object({
    email: z.string().min(3).max(254),
    displayName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
const VerifyOtp = z
  .object({
    email: z.string().min(3).max(254),
    otp: z.string().regex(/^\d{6}$/),
  })
  .strict();
const INVITATION_COOKIE = "collab_invitation";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export function createBetterAuthEmailOtpRoutes(
  input: Readonly<{
    database: Database;
    configuredOrigin: string;
    clock: () => number;
    emailOtp: CollabEmailOtpPort;
    rateLimits: PublicRateLimitPort;
  }>,
) {
  const app = new Hono();
  const mutationAllowed = (request: Request) =>
    request.headers.get("origin") === input.configuredOrigin &&
    request.headers.get("sec-fetch-site") === "same-origin" &&
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() === "application/json";
  const rateLimitAllowed = (request: Request) =>
    input.rateLimits.allow({
      actorId: "PREAUTHENTICATED",
      method: request.method,
      path: new URL(request.url).pathname,
    });
  const accepted = (context: Parameters<typeof getCookie>[0]) =>
    context.json({ ok: true, value: { accepted: true as const } });
  const invalid = (context: Parameters<typeof getCookie>[0]) =>
    context.json(
      {
        error: {
          code: "EMAIL_OTP_INVALID",
          message: "Email verification is invalid or expired.",
        },
      },
      400,
    );
  const invitationExchangeId = (context: Parameters<typeof getCookie>[0]) => {
    const secret = getCookie(context, INVITATION_COOKIE);
    if (!secret || secret.length < 32 || secret.length > 512) return undefined;
    const current = input.clock();
    return input.database
      .query<{ id: string }, [Uint8Array, number, number]>(
        `SELECT exchange.id
         FROM invitation_exchange_sessions AS exchange
         JOIN invitations ON invitations.id = exchange.invitation_id
         WHERE exchange.session_hash = ? AND exchange.consumed_at IS NULL
           AND exchange.revoked_at IS NULL AND exchange.expires_at > ?
           AND invitations.consumed_at IS NULL AND invitations.revoked_at IS NULL
           AND invitations.expires_at > ?`,
      )
      .get(digest(secret), current, current)?.id;
  };
  const successfulVerification = (
    result: Readonly<{ memberId: string; headers: Headers }>,
  ): Response => {
    const headers = new Headers({
      "cache-control": "no-store",
      "content-type": "application/json; charset=UTF-8",
      pragma: "no-cache",
    });
    for (const cookie of result.headers.getSetCookie()) headers.append("set-cookie", cookie);
    return new Response(
      JSON.stringify({
        ok: true,
        value: { memberId: result.memberId, authenticated: true },
      }),
      { status: 200, headers },
    );
  };

  const mount = (prefix: string, invitationBound: boolean) => {
    app.post(`${prefix}/request`, async (context) => {
      if (!mutationAllowed(context.req.raw) || !rateLimitAllowed(context.req.raw))
        return accepted(context);
      const parsed = await parseBoundedJson(context, RequestOtp);
      if (parsed instanceof Response) return accepted(context);
      const exchangeId = invitationBound ? invitationExchangeId(context) : undefined;
      if (invitationBound && !exchangeId) return accepted(context);
      await input.emailOtp.request({
        email: parsed.email,
        ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
        ...(exchangeId ? { invitationExchangeSessionId: exchangeId } : {}),
      });
      return accepted(context);
    });

    app.post(`${prefix}/verify`, async (context) => {
      if (!mutationAllowed(context.req.raw) || !rateLimitAllowed(context.req.raw))
        return invalid(context);
      const parsed = await parseBoundedJson(context, VerifyOtp);
      if (parsed instanceof Response) return invalid(context);
      const exchangeId = invitationBound ? invitationExchangeId(context) : undefined;
      if (invitationBound && !exchangeId) return invalid(context);
      const result = await input.emailOtp.verify({
        email: parsed.email,
        otp: parsed.otp,
        ...(exchangeId ? { invitationExchangeSessionId: exchangeId } : {}),
      });
      return result.ok ? successfulVerification(result.value) : invalid(context);
    });
  };

  mount("/auth/email-otp", false);
  mount("/invitations/auth/email-otp", true);

  app.post("/auth/email-otp/enroll/request", async (context) => {
    if (!mutationAllowed(context.req.raw) || !rateLimitAllowed(context.req.raw))
      return invalid(context);
    const parsed = await parseBoundedJson(context, RequestOtp);
    if (parsed instanceof Response) return invalid(context);
    const result = await input.emailOtp.enrollRequest({
      email: parsed.email,
      request: context.req.raw,
    });
    if (!result.ok && result.error.code === "SESSION_REQUIRED") return context.json(result, 401);
    return result.ok ? accepted(context) : invalid(context);
  });

  app.post("/auth/email-otp/enroll/verify", async (context) => {
    if (!mutationAllowed(context.req.raw) || !rateLimitAllowed(context.req.raw))
      return invalid(context);
    const parsed = await parseBoundedJson(context, VerifyOtp);
    if (parsed instanceof Response) return invalid(context);
    const result = await input.emailOtp.enrollVerify({
      email: parsed.email,
      otp: parsed.otp,
      request: context.req.raw,
    });
    return result.ok ? successfulVerification(result.value) : invalid(context);
  });
  return app;
}
