import { Hono } from "hono";
import type { Result } from "../../../../shared/contracts/result.ts";
import type { Observed } from "../../../modules/connectors/contract.ts";
import type { OutlineDocumentProjection } from "../../../../shared/contracts/outline.ts";

export function createOutlineDocumentRoutes(
  dependencies: Readonly<{
    create(input: unknown, request: Request): Promise<Result<Observed<OutlineDocumentProjection>>>;
    edit(input: unknown, request: Request): Promise<Result<Observed<OutlineDocumentProjection>>>;
  }>,
): Hono {
  const app = new Hono();
  for (const [path, operation] of [
    ["/", dependencies.create],
    ["/:documentId", dependencies.edit],
  ] as const)
    app.post(path, async (context) => {
      const body = await context.req.json().catch(() => null);
      if (!body || typeof body !== "object")
        return context.json(
          { error: { code: "REQUEST_INVALID", message: "The request is invalid." } },
          400,
        );
      const result = await operation(body, context.req.raw);
      context.header("Cache-Control", "no-store");
      return context.json(result, result.ok ? 200 : 409);
    });
  return app;
}
