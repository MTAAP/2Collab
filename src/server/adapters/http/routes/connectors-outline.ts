import { Hono } from "hono";
import type { Result } from "../../../../shared/contracts/result.ts";

type SafeConnection = Readonly<{
  connectorId: string;
  workspaceId: string;
  identityKind: "MEMBER" | "BOT";
  providerUserId: string;
  refreshStatus: "READY" | "REAUTHORIZATION_REQUIRED" | "REVOKED";
  expiresAt?: number;
}>;

export function createOutlineConnectorRoutes(
  dependencies: Readonly<{
    begin(request: Request): Promise<Result<Readonly<{ authorizationUrl: string }>>>;
    finish(request: Request): Promise<Result<SafeConnection>>;
    revoke(request: Request): Promise<Result<Readonly<{ revoked: true }>>>;
  }>,
): Hono {
  const app = new Hono();
  app.post("/oauth/begin", async (context) => {
    const result = await dependencies.begin(context.req.raw);
    context.header("Cache-Control", "no-store");
    return context.json(result, result.ok ? 200 : 403);
  });
  app.post("/oauth/callback", async (context) => {
    const result = await dependencies.finish(context.req.raw);
    context.header("Cache-Control", "no-store");
    return context.json(result, result.ok ? 200 : 403);
  });
  app.post("/revoke", async (context) => {
    const result = await dependencies.revoke(context.req.raw);
    context.header("Cache-Control", "no-store");
    return context.json(result, result.ok ? 200 : 403);
  });
  return app;
}
