import { Hono } from "hono";
import {
  PublicCancelRunRequestSchema,
  PublicCreateRunRequestSchema,
  PublicInspectEvidenceRequestSchema,
  PublicInspectRunRequestSchema,
  PublicResumeRunRequestSchema,
} from "../../../../shared/contracts/public-api.ts";
import type { Result } from "../../../../shared/contracts/result.ts";
import { encodeDomainResult } from "../domain-results.ts";
import {
  authenticatePublicRequest,
  type PublicAuthenticationPort,
} from "../middleware/authentication.ts";
import { parseBoundedJson } from "../middleware/request-limits.ts";
import type { PublicRunOperations } from "../public-schemas.ts";

type Dependencies = Readonly<{
  authentication: PublicAuthenticationPort;
  runs: PublicRunOperations;
}>;

function denied(
  response: Extract<Awaited<ReturnType<typeof authenticatePublicRequest>>, { ok: false }>,
) {
  return Response.json(response, { status: 401 });
}

export function createRunRoutes(dependencies: Dependencies): Hono {
  const app = new Hono();

  app.post("/", async (context) => {
    const authenticated = await authenticatePublicRequest(
      context.req.raw,
      dependencies.authentication,
    );
    if (!authenticated.ok) return denied(authenticated);
    if (
      authenticated.value.browser &&
      !dependencies.authentication.verifyBrowserMutation(context.req.raw, authenticated.value.actor)
    ) {
      return context.json(
        { error: { code: "CSRF_INVALID", message: "CSRF proof is invalid." } },
        403,
      );
    }
    const request = await parseBoundedJson(context, PublicCreateRunRequestSchema);
    if (request instanceof Response) return request;
    return encodeDomainResult(
      context,
      await dependencies.runs.create(authenticated.value.actor, request),
    );
  });

  app.get("/:runId", async (context) => {
    const authenticated = await authenticatePublicRequest(
      context.req.raw,
      dependencies.authentication,
    );
    if (!authenticated.ok) return denied(authenticated);
    const request = PublicInspectRunRequestSchema.safeParse({ runId: context.req.param("runId") });
    if (!request.success)
      return context.json(
        { error: { code: "REQUEST_INVALID", message: "The request is invalid." } },
        400,
      );
    return encodeDomainResult(
      context,
      await dependencies.runs.inspect(authenticated.value.actor, request.data),
    );
  });

  app.get("/:runId/evidence", async (context) => {
    const authenticated = await authenticatePublicRequest(
      context.req.raw,
      dependencies.authentication,
    );
    if (!authenticated.ok) return denied(authenticated);
    const request = PublicInspectEvidenceRequestSchema.safeParse({
      runId: context.req.param("runId"),
      after: context.req.query("after"),
      limit: context.req.query("limit") ? Number(context.req.query("limit")) : undefined,
    });
    if (!request.success)
      return context.json(
        { error: { code: "REQUEST_INVALID", message: "The request is invalid." } },
        400,
      );
    return encodeDomainResult(
      context,
      await dependencies.runs.evidence(authenticated.value.actor, request.data),
    );
  });

  for (const action of ["cancel", "resume"] as const) {
    app.post(`/:runId/${action}`, async (context) => {
      const authenticated = await authenticatePublicRequest(
        context.req.raw,
        dependencies.authentication,
      );
      if (!authenticated.ok) return denied(authenticated);
      if (
        authenticated.value.browser &&
        !dependencies.authentication.verifyBrowserMutation(
          context.req.raw,
          authenticated.value.actor,
        )
      ) {
        return context.json(
          { error: { code: "CSRF_INVALID", message: "CSRF proof is invalid." } },
          403,
        );
      }
      const body = await parseBoundedJson(
        context,
        action === "cancel" ? PublicCancelRunRequestSchema : PublicResumeRunRequestSchema,
      );
      if (body instanceof Response) return body;
      if (body.runId !== context.req.param("runId")) {
        return context.json(
          { error: { code: "REQUEST_INVALID", message: "The request is invalid." } },
          400,
        );
      }
      const result =
        action === "cancel"
          ? await dependencies.runs.cancel(authenticated.value.actor, body as never)
          : await dependencies.runs.resume(authenticated.value.actor, body as never);
      return encodeDomainResult(context, result as Result<unknown>);
    });
  }

  return app;
}
