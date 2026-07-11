import { Hono } from "hono";
import { ExactRevisionMutationSchema } from "../../../modules/connectors/contract.ts";
import {
  GitHubMutationSchema,
  type GitHubMutation,
  type GitHubProjection,
} from "../../../../shared/contracts/github.ts";
import type { MemberActor } from "../../../../shared/contracts/actors.ts";
import type { Result } from "../../../../shared/contracts/result.ts";
import type { ExactRevisionMutation, Observed } from "../../../modules/connectors/contract.ts";
import {
  authenticatePublicRequest,
  type PublicAuthenticationPort,
} from "../middleware/authentication.ts";
import {
  enforceRateLimit,
  parseBoundedJson,
  type PublicRateLimitPort,
} from "../middleware/request-limits.ts";

export type GitHubIssueRouteDependencies = Readonly<{
  authentication: PublicAuthenticationPort;
  rateLimits: PublicRateLimitPort;
  configuredOrigin: string;
  mutate(
    actor: MemberActor,
    command: ExactRevisionMutation<GitHubMutation>,
  ): Promise<Result<Observed<GitHubProjection>>>;
}>;

export function createGitHubIssueRoutes(dependencies: GitHubIssueRouteDependencies): Hono {
  const app = new Hono();
  app.post("/api/v1/github/mutations", async (context) => {
    const authenticated = await authenticatePublicRequest(
      context.req.raw,
      dependencies.authentication,
    );
    if (!authenticated.ok) return context.json(authenticated, 401);
    const rate = enforceRateLimit(
      context,
      dependencies.rateLimits,
      authenticated.value.actor.memberId,
    );
    if (rate) return rate;
    if (
      authenticated.value.browser &&
      (context.req.header("origin") !== dependencies.configuredOrigin ||
        !dependencies.authentication.verifyBrowserMutation(
          context.req.raw,
          authenticated.value.actor,
        ))
    )
      return context.json(
        { error: { code: "CSRF_INVALID", message: "CSRF proof is invalid." } },
        403,
      );
    const command = await parseBoundedJson(
      context,
      ExactRevisionMutationSchema(GitHubMutationSchema),
    );
    if (command instanceof Response) return command;
    const result = await dependencies.mutate(
      authenticated.value.actor,
      command as ExactRevisionMutation<GitHubMutation>,
    );
    return context.json(
      result,
      result.ok ? 200 : result.error.code === "SOURCE_REVISION_STALE" ? 409 : 400,
    );
  });
  return app;
}
