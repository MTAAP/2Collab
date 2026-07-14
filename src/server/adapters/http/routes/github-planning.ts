import { Hono } from "hono";
import type { MemberActor } from "../../../../shared/contracts/actors.ts";
import type { GitHubProjection } from "../../../../shared/contracts/github.ts";
import type { Result } from "../../../../shared/contracts/result.ts";
import {
  authenticatePublicRequest,
  type PublicAuthenticationPort,
} from "../middleware/authentication.ts";
import { enforceRateLimit, type PublicRateLimitPort } from "../middleware/request-limits.ts";

export function createGitHubPlanningRoutes(
  dependencies: Readonly<{
    authentication: PublicAuthenticationPort;
    rateLimits: PublicRateLimitPort;
    authorizeProject(
      actor: MemberActor,
      projectId: string,
    ): Promise<Result<Readonly<{ authorized: true }>>>;
    list(actor: MemberActor, projectId: string): Promise<Result<readonly GitHubProjection[]>>;
  }>,
): Hono {
  const app = new Hono();
  app.get("/api/v1/projects/:projectId/github/planning", async (context) => {
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
    const projectId = context.req.param("projectId");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId))
      return context.json(
        { error: { code: "REQUEST_INVALID", message: "The request is invalid." } },
        400,
      );
    const authorized = await dependencies.authorizeProject(authenticated.value.actor, projectId);
    if (!authorized.ok) return context.json(authorized, 403);
    const result = await dependencies.list(authenticated.value.actor, projectId);
    return context.json(result, result.ok ? 200 : 400);
  });
  return app;
}
