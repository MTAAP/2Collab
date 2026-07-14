import { Hono } from "hono";
import { z } from "zod";
import { IdentifierSchema } from "../../../../shared/contracts/ids.ts";
import type { MemberActor } from "../../../../shared/contracts/actors.ts";
import type { Result } from "../../../../shared/contracts/result.ts";
import {
  authenticatePublicRequest,
  type PublicAuthenticationPort,
} from "../middleware/authentication.ts";
import { parseBoundedJson } from "../middleware/request-limits.ts";

const CoalesceSchema = z
  .object({
    projectId: IdentifierSchema,
    aliasRecordId: IdentifierSchema,
    canonicalRecordId: IdentifierSchema,
  })
  .strict();
export function createCoordinationRecordRoutes(
  dependencies: Readonly<{
    authentication: PublicAuthenticationPort;
    coalesce(actor: MemberActor, input: z.infer<typeof CoalesceSchema>): Promise<Result<unknown>>;
  }>,
): Hono {
  const app = new Hono();
  app.post("/api/v1/coordination-records/coalesce", async (context) => {
    const authenticated = await authenticatePublicRequest(
      context.req.raw,
      dependencies.authentication,
    );
    if (!authenticated.ok) return context.json(authenticated, 401);
    const input = await parseBoundedJson(context, CoalesceSchema);
    if (input instanceof Response) return input;
    const result = await dependencies.coalesce(authenticated.value.actor, input);
    return context.json(result, result.ok ? 200 : 409);
  });
  return app;
}
