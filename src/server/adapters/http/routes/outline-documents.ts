import { Hono } from "hono";
import type { MemberActor } from "../../../../shared/contracts/actors.ts";
import type { ProjectId } from "../../../../shared/contracts/ids.ts";
import type { Result } from "../../../../shared/contracts/result.ts";
import type { Observed } from "../../../modules/connectors/contract.ts";
import type { OutlineDocumentProjection } from "../../../../shared/contracts/outline.ts";
import { OutlineMutationSchema } from "../../../../shared/contracts/outline.ts";
import { ExactRevisionMutationSchema } from "../../../modules/connectors/contract.ts";
import {
  authorizeOutlineRequest,
  type OutlineHttpSecurity,
  type OutlineProjectAuthorization,
} from "../middleware/outline-security.ts";
import { parseBoundedJson } from "../middleware/request-limits.ts";

export function createOutlineDocumentRoutes(
  dependencies: OutlineHttpSecurity &
    OutlineProjectAuthorization &
    Readonly<{
      create(
        actor: MemberActor,
        input: unknown,
      ): Promise<Result<Observed<OutlineDocumentProjection>>>;
      edit(
        actor: MemberActor,
        input: unknown,
      ): Promise<Result<Observed<OutlineDocumentProjection>>>;
    }>,
): Hono {
  const app = new Hono();
  for (const [path, operation] of [
    ["/", dependencies.create],
    ["/:documentId", dependencies.edit],
  ] as const)
    app.post(path, async (context) => {
      const actor = await authorizeOutlineRequest(context, dependencies, true);
      if (actor instanceof Response) return actor;
      const body = await parseBoundedJson(
        context,
        ExactRevisionMutationSchema(OutlineMutationSchema),
      );
      if (body instanceof Response) return body;
      const project = await dependencies.authorizeProject(actor, body.projectId as ProjectId);
      if (!project.ok) return context.json(project, 403);
      const result = await operation(actor, body);
      context.header("Cache-Control", "no-store");
      return context.json(result, result.ok ? 200 : 409);
    });
  return app;
}
