import { Hono } from "hono";
import type { PublicAuthenticationPort } from "./middleware/authentication.ts";
import type { PublicRunOperations } from "./public-schemas.ts";
import { createRunRoutes } from "./routes/runs.ts";
import { foundationSecurityHeaders } from "./security-headers.ts";

export type FoundationHttpDependencies = Readonly<{
  configuredOrigin: string;
  authentication: PublicAuthenticationPort;
  runs: PublicRunOperations;
}>;

export function createFoundationHttpApp(dependencies: FoundationHttpDependencies): Hono {
  const app = new Hono();
  app.use("*", foundationSecurityHeaders());
  app.route("/api/v1/runs", createRunRoutes(dependencies));
  app.notFound((context) =>
    context.json(
      { error: { code: "NOT_FOUND", message: "The requested API resource does not exist." } },
      404,
    ),
  );
  return app;
}
