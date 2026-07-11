import { Hono } from "hono";
import type { TemplateBindingOperations } from "../../../modules/templates/bindings.ts";
import {
  authenticatePublicRequest,
  type PublicAuthenticationPort,
} from "../middleware/authentication.ts";
import { enforceRateLimit, type PublicRateLimitPort } from "../middleware/request-limits.ts";
import { parseBoundedJson } from "../middleware/request-limits.ts";
import { z } from "zod";

const BindingSchema = z.record(z.string().min(1).max(128), z.unknown());

export function createTemplateRoutes(
  dependencies: Readonly<{
    operations: TemplateBindingOperations;
    authentication: PublicAuthenticationPort;
    rateLimits: PublicRateLimitPort;
  }>,
): Hono {
  const app = new Hono();
  app.post("/api/v1/workflow-presets/bind", async (context) => {
    const authenticated = await authenticatePublicRequest(
      context.req.raw,
      dependencies.authentication,
    );
    if (!authenticated.ok) return context.json(authenticated, 401);
    if (
      authenticated.value.browser &&
      !dependencies.authentication.verifyBrowserMutation(context.req.raw, authenticated.value.actor)
    )
      return context.json(
        { error: { code: "CSRF_INVALID", message: "The browser mutation proof is invalid." } },
        403,
      );
    const limited = enforceRateLimit(
      context,
      dependencies.rateLimits,
      authenticated.value.actor.memberId,
    );
    if (limited) return limited;
    const body = await parseBoundedJson(context, BindingSchema);
    if (body instanceof Response) return body;
    const { actorMemberId: _ignored, ...input } = body as Record<string, unknown>;
    const result = await dependencies.operations.bind({
      ...input,
      actorMemberId: authenticated.value.actor.memberId,
    });
    return context.json(result, result.ok ? 200 : 400);
  });
  return app;
}
