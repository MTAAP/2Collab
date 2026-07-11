import { Hono } from "hono";
import type { GitHubProjection } from "../../../../shared/contracts/github.ts";
import type { Result } from "../../../../shared/contracts/result.ts";

export function createGitHubPlanningRoutes(
  dependencies: Readonly<{ list(projectId: string): Promise<Result<readonly GitHubProjection[]>> }>,
): Hono {
  const app = new Hono();
  app.get("/api/v1/projects/:projectId/github/planning", async (context) => {
    const projectId = context.req.param("projectId");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId))
      return context.json(
        { error: { code: "REQUEST_INVALID", message: "The request is invalid." } },
        400,
      );
    const result = await dependencies.list(projectId);
    return context.json(result, result.ok ? 200 : 400);
  });
  return app;
}
