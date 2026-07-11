import { Hono } from "hono";
import { z } from "zod";
import type { Result } from "../../../../shared/contracts/result.ts";
import { ScopedSearchSchema } from "../../../modules/connectors/contract.ts";
import type {
  AuthorizedScopedSearch,
  FederatedSearchResult,
} from "../../../modules/federated-search/contract.ts";

const RequestSchema = z.object({ query: ScopedSearchSchema }).strict();

export function createOutlineSearchRoutes(
  dependencies: Readonly<{
    authorize(request: Request): Promise<Result<AuthorizedScopedSearch>>;
    search(command: AuthorizedScopedSearch): Promise<Result<FederatedSearchResult>>;
  }>,
): Hono {
  const app = new Hono();
  app.post("/", async (context) => {
    const parsed = RequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success)
      return context.json(
        { error: { code: "REQUEST_INVALID", message: "The request is invalid." } },
        400,
      );
    const authorized = await dependencies.authorize(context.req.raw);
    if (!authorized.ok) return context.json(authorized, 403);
    const result = await dependencies.search({ ...authorized.value, query: parsed.data.query });
    context.header("Cache-Control", "no-store");
    return context.json(result, result.ok ? 200 : 403);
  });
  return app;
}
