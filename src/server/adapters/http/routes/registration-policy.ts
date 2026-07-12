import { Hono, type Context } from "hono";
import { z } from "zod";
import type { RegistrationPolicyService } from "../../../modules/identity/registration-policy.ts";
import type { PublicAuthenticationPort } from "../middleware/authentication.ts";
import { authenticatePublicRequest } from "../middleware/authentication.ts";
import {
  enforceRateLimit,
  parseBoundedJson,
  type PublicRateLimitPort,
} from "../middleware/request-limits.ts";

const Revision = z.number().int().positive();
const UpdateMode = z
  .object({ expectedRevision: Revision, mode: z.enum(["CLOSED", "INVITE_ONLY", "ALLOWLIST"]) })
  .strict();
const AddRule = z
  .object({
    expectedPolicyRevision: Revision,
    effect: z.enum(["ALLOW", "DENY"]),
    matcher: z.enum(["EMAIL", "DOMAIN"]),
    value: z.string().trim().min(1).max(254),
    includeSubdomains: z.boolean(),
  })
  .strict();
const RevokeRule = z.object({ expectedPolicyRevision: Revision }).strict();

type Dependencies = Readonly<{
  configuredOrigin: string;
  authentication: PublicAuthenticationPort;
  rateLimits: PublicRateLimitPort;
  service: RegistrationPolicyService;
  emailLoginEnabled: boolean;
}>;

async function actor(context: Context, dependencies: Dependencies, mutation: boolean) {
  const authenticated = await authenticatePublicRequest(
    context.req.raw,
    dependencies.authentication,
  );
  if (!authenticated.ok) return context.json(authenticated, 401);
  const limited = enforceRateLimit(
    context,
    dependencies.rateLimits,
    authenticated.value.actor.memberId,
  );
  if (limited) return limited;
  if (
    mutation &&
    (!authenticated.value.browser ||
      context.req.header("origin") !== dependencies.configuredOrigin ||
      !dependencies.authentication.verifyBrowserMutation(
        context.req.raw,
        authenticated.value.actor,
      ))
  )
    return context.json(
      { error: { code: "CSRF_INVALID", message: "CSRF proof is invalid." } },
      403,
    );
  return authenticated.value.actor;
}

function response(context: Context, result: ReturnType<RegistrationPolicyService["readForOwner"]>) {
  if (result.ok) return context.json({ ok: true, value: result.value });
  const status = result.error.code === "REGISTRATION_POLICY_OWNER_REQUIRED" ? 403 : 409;
  return context.json(result, status);
}

export function createRegistrationPolicyRoutes(dependencies: Dependencies): Hono {
  const app = new Hono();

  app.get("/registration-policy", async (context) => {
    const authenticated = await actor(context, dependencies, false);
    if (authenticated instanceof Response) return authenticated;
    const result = dependencies.service.readForOwner(authenticated.memberId);
    return result.ok
      ? context.json({
          ok: true,
          value: { ...result.value, emailLoginEnabled: dependencies.emailLoginEnabled },
        })
      : context.json(result, 403);
  });

  app.put("/registration-policy", async (context) => {
    const authenticated = await actor(context, dependencies, true);
    if (authenticated instanceof Response) return authenticated;
    const body = await parseBoundedJson(context, UpdateMode);
    if (body instanceof Response) return body;
    return response(
      context,
      dependencies.service.updateMode({ actorMemberId: authenticated.memberId, ...body }),
    );
  });

  app.post("/registration-policy/rules", async (context) => {
    const authenticated = await actor(context, dependencies, true);
    if (authenticated instanceof Response) return authenticated;
    const body = await parseBoundedJson(context, AddRule);
    if (body instanceof Response) return body;
    const result = dependencies.service.addRule({ actorMemberId: authenticated.memberId, ...body });
    return result.ok
      ? context.json({ ok: true, value: result.value }, 201)
      : context.json(result, 409);
  });

  app.delete("/registration-policy/rules/:ruleId", async (context) => {
    const authenticated = await actor(context, dependencies, true);
    if (authenticated instanceof Response) return authenticated;
    const body = await parseBoundedJson(context, RevokeRule);
    if (body instanceof Response) return body;
    return response(
      context,
      dependencies.service.revokeRule({
        actorMemberId: authenticated.memberId,
        expectedPolicyRevision: body.expectedPolicyRevision,
        ruleId: context.req.param("ruleId"),
      }),
    );
  });

  return app;
}
