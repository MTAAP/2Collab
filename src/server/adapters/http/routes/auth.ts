import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import {
  BootstrapDeploymentSchema,
  ExchangeInvitationSecretSchema,
} from "../../../../shared/contracts/identity.ts";
import type { IdentityAuthority } from "../../../modules/identity/contract.ts";
import { domainHttpStatus } from "../domain-results.ts";
import {
  enforceRateLimit,
  type PublicRateLimitPort,
  parseBoundedJson,
} from "../middleware/request-limits.ts";

type BrowserIdentityPort = Pick<
  IdentityAuthority,
  "beginPasskeyRegistration" | "bootstrap" | "exchangeInvitation"
>;

const PublicBeginBootstrapPasskeySchema = z
  .object({
    idempotencyKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    bootstrapSecret: z.string().min(32).max(512),
    displayName: z.string().trim().min(1).max(120),
  })
  .strict();

export function createBrowserAuthRoutes(
  dependencies: Readonly<{
    configuredOrigin: string;
    identity: BrowserIdentityPort;
    rateLimits: PublicRateLimitPort;
  }>,
): Hono {
  const app = new Hono();
  const secure = new URL(dependencies.configuredOrigin).protocol === "https:";

  app.use("*", async (context, next) => {
    if (context.req.header("origin") !== dependencies.configuredOrigin) {
      return context.json(
        { error: { code: "ORIGIN_INVALID", message: "Request origin is invalid." } },
        403,
      );
    }
    const rateLimited = enforceRateLimit(context, dependencies.rateLimits, "PREAUTHENTICATED");
    if (rateLimited) return rateLimited;
    await next();
  });

  app.post("/auth/passkeys/registration/begin", async (context) => {
    const input = await parseBoundedJson(context, PublicBeginBootstrapPasskeySchema);
    if (input instanceof Response) return input;
    const result = await dependencies.identity.beginPasskeyRegistration({
      idempotencyKey: input.idempotencyKey,
      principal: { kind: "BOOTSTRAP", secret: input.bootstrapSecret },
      displayName: input.displayName,
    });
    return result.ok
      ? context.json(result)
      : context.json(result, domainHttpStatus(result.error.code));
  });

  app.post("/bootstrap", async (context) => {
    const input = await parseBoundedJson(context, BootstrapDeploymentSchema);
    if (input instanceof Response) return input;
    const result = await dependencies.identity.bootstrap(input);
    if (!result.ok) return context.json(result, domainHttpStatus(result.error.code));
    setCookie(context, "collab_session", `${result.value.id}.${result.value.proof}`, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
      sameSite: "Strict",
      secure,
    });
    return context.json({
      ok: true,
      value: {
        memberId: result.value.memberId,
        expiresAt: result.value.expiresAt,
        csrfProof: result.value.csrfProof,
      },
    });
  });

  app.post("/invitations/exchange", async (context) => {
    const input = await parseBoundedJson(context, ExchangeInvitationSecretSchema);
    if (input instanceof Response) return input;
    const result = await dependencies.identity.exchangeInvitation(input);
    if (!result.ok) return context.json(result, domainHttpStatus(result.error.code));
    setCookie(context, "collab_invitation", result.value.secret, {
      httpOnly: true,
      maxAge: 15 * 60,
      path: "/join",
      sameSite: "Strict",
      secure,
    });
    return context.json({
      ok: true,
      value: { invitationId: result.value.invitationId, expiresAt: result.value.expiresAt },
    });
  });

  return app;
}
