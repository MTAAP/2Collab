import type { Context } from "hono";
import type { MemberActor } from "../../../../shared/contracts/actors.ts";
import type { ProjectId } from "../../../../shared/contracts/ids.ts";
import type { Result } from "../../../../shared/contracts/result.ts";
import { authenticatePublicRequest, type PublicAuthenticationPort } from "./authentication.ts";
import { enforceRateLimit, type PublicRateLimitPort } from "./request-limits.ts";

export type OutlineHttpSecurity = Readonly<{
  authentication: PublicAuthenticationPort;
  configuredOrigin: string;
  rateLimits: PublicRateLimitPort;
}>;

export type OutlineProjectAuthorization = Readonly<{
  authorizeProject(
    actor: MemberActor,
    projectId: ProjectId,
  ): Promise<Result<Readonly<{ authorized: true }>>>;
}>;

export async function authorizeOutlineRequest(
  context: Context,
  security: OutlineHttpSecurity,
  mutation: boolean,
): Promise<MemberActor | Response> {
  const authenticated = await authenticatePublicRequest(context.req.raw, security.authentication);
  if (!authenticated.ok) return context.json(authenticated, 401);
  const limited = enforceRateLimit(
    context,
    security.rateLimits,
    authenticated.value.actor.memberId,
  );
  if (limited) return limited;
  if (
    mutation &&
    authenticated.value.browser &&
    (context.req.header("origin") !== security.configuredOrigin ||
      !security.authentication.verifyBrowserMutation(context.req.raw, authenticated.value.actor))
  ) {
    return context.json(
      { error: { code: "CSRF_INVALID", message: "CSRF proof is invalid." } },
      403,
    );
  }
  return authenticated.value.actor;
}
