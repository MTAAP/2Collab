import { Hono } from "hono";
import { z } from "zod";
import type { Result } from "../../../../shared/contracts/result.ts";
import type { MemberActor } from "../../../../shared/contracts/actors.ts";
import { IdentifierSchema } from "../../../../shared/contracts/ids.ts";
import { ScopedSearchSchema } from "../../../modules/connectors/contract.ts";
import type {
  AuthorizedScopedSearch,
  FederatedSearchResult,
} from "../../../modules/federated-search/contract.ts";
import {
  authorizeOutlineRequest,
  type OutlineHttpSecurity,
  type OutlineProjectAuthorization,
} from "../middleware/outline-security.ts";
import { parseBoundedJson } from "../middleware/request-limits.ts";

const RequestSchema = z
  .object({ projectId: IdentifierSchema, connectorId: IdentifierSchema, query: ScopedSearchSchema })
  .strict();

export function createOutlineSearchRoutes(
  dependencies: OutlineHttpSecurity &
    OutlineProjectAuthorization &
    Readonly<{
      authorize(
        actor: MemberActor,
        projectId: string,
        connectorId: string,
      ): Promise<Result<AuthorizedScopedSearch>>;
      search(command: AuthorizedScopedSearch): Promise<Result<FederatedSearchResult>>;
    }>,
): Hono {
  const app = new Hono();
  app.post("/", async (context) => {
    const actor = await authorizeOutlineRequest(context, dependencies, false);
    if (actor instanceof Response) return actor;
    const parsed = await parseBoundedJson(context, RequestSchema);
    if (parsed instanceof Response) return parsed;
    const authorized = await dependencies.authorize(actor, parsed.projectId, parsed.connectorId);
    if (!authorized.ok) return context.json(authorized, 403);
    const project = await dependencies.authorizeProject(actor, authorized.value.scope.projectId);
    if (!project.ok) return context.json(project, 403);
    const result = await dependencies.search({ ...authorized.value, query: parsed.query });
    context.header("Cache-Control", "no-store");
    return context.json(result, result.ok ? 200 : 403);
  });
  return app;
}
