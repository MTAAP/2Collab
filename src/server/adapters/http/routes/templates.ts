import { Hono } from "hono";
import type { TemplateBindingOperations } from "../../../modules/templates/bindings.ts";

export function createTemplateRoutes(operations: TemplateBindingOperations): Hono {
  const app = new Hono();
  app.post("/api/v1/workflow-presets/bind", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    if (!body || typeof body !== "object")
      return context.json(
        {
          ok: false,
          error: { code: "REQUEST_INVALID", message: "The request is invalid.", retry: "NEVER" },
        },
        400,
      );
    const result = await operations.bind(body);
    return context.json(result, result.ok ? 200 : 400);
  });
  return app;
}
