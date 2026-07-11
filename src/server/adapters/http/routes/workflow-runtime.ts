import { type Context, Hono } from "hono";
import { z } from "zod";
import { WorkflowStepResultSchema } from "../../../../shared/contracts/workflow-results.ts";
import type { WorkflowRuntimeOperations } from "../../../modules/workflows/runtime-operations.ts";
import {
  authenticatePublicRequest,
  type PublicAuthenticationPort,
} from "../middleware/authentication.ts";
import {
  enforceRateLimit,
  type PublicRateLimitPort,
  parseBoundedJson,
} from "../middleware/request-limits.ts";

const Identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const Inputs = z.record(
  z.string().min(1).max(64),
  z.union([z.string().max(16_384), z.number().finite(), z.boolean()]),
);
const StartSchema = z
  .object({
    idempotencyKey: Identifier,
    workflowExecutionId: Identifier,
    coordinationRecordId: Identifier,
    coordinationRevision: z.number().int().positive(),
    templateVersionId: Identifier,
    presetVersionId: Identifier,
    inputs: Inputs.optional(),
    workflowPresetId: Identifier,
    workflowPresetVersion: z.number().int().positive(),
  })
  .strict();
const ControlSchema = z
  .object({ idempotencyKey: Identifier, expectedRevision: z.number().int().positive() })
  .strict();
const DecisionSchema = z
  .object({
    decisionId: Identifier,
    nodeKey: Identifier,
    choice: z.string().min(1).max(128),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const EventSchema = z
  .object({
    eventId: Identifier,
    expectedRevision: z.number().int().positive(),
    stepOccurrenceId: Identifier,
    runId: Identifier,
    result: WorkflowStepResultSchema,
  })
  .strict();

export function createWorkflowRuntimeRoutes(
  dependencies: Readonly<{
    authentication: PublicAuthenticationPort;
    rateLimits: PublicRateLimitPort;
    operations: WorkflowRuntimeOperations;
  }>,
): Hono {
  const app = new Hono();
  const actor = async (context: Context) => {
    const authenticated = await authenticatePublicRequest(
      context.req.raw,
      dependencies.authentication,
    );
    if (!authenticated.ok) return { response: context.json(authenticated, 401) } as const;
    if (
      authenticated.value.browser &&
      !dependencies.authentication.verifyBrowserMutation(context.req.raw, authenticated.value.actor)
    )
      return {
        response: context.json(
          { error: { code: "CSRF_INVALID", message: "The browser mutation proof is invalid." } },
          403,
        ),
      } as const;
    const limited = enforceRateLimit(
      context,
      dependencies.rateLimits,
      authenticated.value.actor.memberId,
    );
    return limited
      ? ({ response: limited } as const)
      : ({ value: authenticated.value.actor } as const);
  };
  const respond = (
    context: Context,
    result: Awaited<ReturnType<WorkflowRuntimeOperations["show"]>>,
  ) =>
    context.json(
      result,
      result.ok
        ? 200
        : result.error.code.includes("CONFLICT")
          ? 409
          : result.error.code === "WORKFLOW_NOT_FOUND"
            ? 404
            : 400,
    );

  app.post("/api/v1/workflow-executions", async (context) => {
    const authenticated = await actor(context);
    if ("response" in authenticated) return authenticated.response;
    const body = await parseBoundedJson(context, StartSchema);
    if (body instanceof Response) return body;
    return respond(
      context,
      await dependencies.operations.start(authenticated.value, body as never),
    );
  });
  app.get("/api/v1/workflow-executions/:id", async (context) => {
    const authenticated = await actor(context);
    if ("response" in authenticated) return authenticated.response;
    return respond(
      context,
      await dependencies.operations.show(authenticated.value, context.req.param("id")),
    );
  });
  for (const action of ["pause", "resume", "cancel"] as const)
    app.post(`/api/v1/workflow-executions/:id/${action}`, async (context) => {
      const authenticated = await actor(context);
      if ("response" in authenticated) return authenticated.response;
      const body = await parseBoundedJson(context, ControlSchema);
      if (body instanceof Response) return body;
      return respond(
        context,
        await dependencies.operations[action](authenticated.value, {
          ...body,
          workflowExecutionId: context.req.param("id"),
        }),
      );
    });
  app.post("/api/v1/workflow-executions/:id/decisions", async (context) => {
    const authenticated = await actor(context);
    if ("response" in authenticated) return authenticated.response;
    const body = await parseBoundedJson(context, DecisionSchema);
    if (body instanceof Response) return body;
    return respond(
      context,
      await dependencies.operations.decide(authenticated.value, {
        ...body,
        workflowExecutionId: context.req.param("id"),
      }),
    );
  });
  app.post("/api/v1/workflow-executions/:id/events", async (context) => {
    const authenticated = await actor(context);
    if ("response" in authenticated) return authenticated.response;
    const body = await parseBoundedJson(context, EventSchema);
    if (body instanceof Response) return body;
    return respond(
      context,
      await dependencies.operations.event(authenticated.value, {
        ...body,
        workflowExecutionId: context.req.param("id"),
      }),
    );
  });
  return app;
}
