import { Hono } from "hono";
import { z } from "zod";
import {
  CanvasLayoutSchema,
  WorkflowDefinitionSchema,
} from "../../../../shared/contracts/workflow.ts";
import type { WorkflowAuthoringOperations } from "../../../modules/workflows/authoring.ts";

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
    actorMemberId(request: Request): string | null;
    operations: WorkflowAuthoringOperations;
  }>,
): Hono {
  const app = new Hono();
  app.post("/api/v1/workflow-drafts/:draftId", async (context) => {
    const actorMemberId = dependencies.actorMemberId(context.req.raw);
    if (!actorMemberId)
      return context.json(
        {
          ok: false,
          error: {
            code: "MEMBER_AUTHORITY_REQUIRED",
            message: "Active member authority is required.",
            retry: "NEVER",
          },
        },
        401,
      );
    const body = SaveSchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success || body.data.draftId !== context.req.param("draftId"))
      return context.json(
        {
          ok: false,
          error: { code: "REQUEST_INVALID", message: "The request is invalid.", retry: "NEVER" },
        },
        400,
      );
    const result = await dependencies.operations.save({ ...body.data, actorMemberId });
    return context.json(
      result,
      result.ok ? 200 : result.error.code === "WORKFLOW_DRAFT_REVISION_STALE" ? 409 : 400,
    );
  });
  return app;
}
