import { Hono } from "hono";
import { z } from "zod";
import {
  CanvasLayoutSchema,
  WorkflowDefinitionSchema,
} from "../../../../shared/contracts/workflow.ts";
import type { WorkflowAuthoringOperations } from "../../../modules/workflows/authoring.ts";
import type { PublicAuthenticationPort } from "../middleware/authentication.ts";
import { authenticatePublicRequest } from "../middleware/authentication.ts";
import type { PublicRateLimitPort } from "../middleware/request-limits.ts";
import { enforceRateLimit, parseBoundedJson } from "../middleware/request-limits.ts";

const SaveSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    draftId: z.string().min(1).max(128),
    templateKey: z.string().min(1).max(128),
    expectedRevision: z.number().int().nonnegative(),
    definition: WorkflowDefinitionSchema,
    layout: CanvasLayoutSchema,
  })
  .strict();

export function createWorkflowRoutes(
  dependencies: Readonly<{
    authentication: PublicAuthenticationPort;
    rateLimits: PublicRateLimitPort;
    operations: WorkflowAuthoringOperations;
  }>,
): Hono {
  const app = new Hono();
  app.post("/api/v1/workflow-drafts/:draftId", async (context) => {
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
    const body = await parseBoundedJson(context, SaveSchema);
    if (body instanceof Response || body.draftId !== context.req.param("draftId"))
      return context.json(
        {
          ok: false,
          error: { code: "REQUEST_INVALID", message: "The request is invalid.", retry: "NEVER" },
        },
        400,
      );
    const result = await dependencies.operations.save({
      ...body,
      actorMemberId: authenticated.value.actor.memberId,
    });
    return context.json(
      result,
      result.ok ? 200 : result.error.code === "WORKFLOW_DRAFT_REVISION_STALE" ? 409 : 400,
    );
  });
  return app;
}
