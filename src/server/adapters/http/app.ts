import { Hono } from "hono";
import { createMcpHttpHandler } from "../mcp/http.ts";
import type { PublicAuthenticationPort } from "./middleware/authentication.ts";
import type { PublicRateLimitPort } from "./middleware/request-limits.ts";
import type { PublicRunOperations } from "./public-schemas.ts";
import { createRunRoutes } from "./routes/runs.ts";
import { foundationSecurityHeaders } from "./security-headers.ts";

export type FoundationHttpDependencies = Readonly<{
  configuredOrigin: string;
  authentication: PublicAuthenticationPort;
  rateLimits: PublicRateLimitPort;
  runs: PublicRunOperations;
}>;

export function createFoundationHttpApp(dependencies: FoundationHttpDependencies): Hono {
  const app = new Hono();
  app.use("*", foundationSecurityHeaders());
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  app.route("/api/v1/runs", createRunRoutes(dependencies));
  const mcp = createMcpHttpHandler(dependencies);
  app.all("/mcp", (context) => mcp(context.req.raw));
  app.notFound((context) =>
    context.json(
      { error: { code: "NOT_FOUND", message: "The requested API resource does not exist." } },
      404,
    ),
  );
  return app;
}
