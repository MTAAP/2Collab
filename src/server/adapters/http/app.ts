import { Hono } from "hono";
import type { PublicAuthenticationPort } from "./middleware/authentication.ts";
import type {
  OutlineHttpSecurity,
  OutlineProjectAuthorization,
} from "./middleware/outline-security.ts";
import type { PublicRateLimitPort } from "./middleware/request-limits.ts";
import type { PublicRunOperations } from "./public-schemas.ts";
import { createBrowserAuthRoutes } from "./routes/auth.ts";
import { createOutlineConnectorRoutes } from "./routes/connectors-outline.ts";
import { createDeviceAuthRoutes } from "./routes/device-auth.ts";
import { createOutlineDocumentRoutes } from "./routes/outline-documents.ts";
import { createOutlineSearchRoutes } from "./routes/outline-search.ts";
import { createRunRoutes } from "./routes/runs.ts";
import { createRunnerPairingRoutes } from "./routes/runner-pairing.ts";
import { createRunnerConfigurationRoutes } from "./routes/runner-configuration.ts";
import { foundationSecurityHeaders } from "./security-headers.ts";

export type FoundationHttpDependencies = Readonly<{
  configuredOrigin: string;
  authentication: PublicAuthenticationPort;
  rateLimits: PublicRateLimitPort;
  runs: PublicRunOperations;
  browserIdentity?: Parameters<typeof createBrowserAuthRoutes>[0]["identity"];
  deviceIdentity?: Parameters<typeof createDeviceAuthRoutes>[0]["authority"];
  runnerPairing?: Parameters<typeof createRunnerPairingRoutes>[0]["registry"];
  runnerAuthentication?: Parameters<typeof createRunnerPairingRoutes>[0]["runnerAuthentication"];
  runnerConfiguration?: Parameters<typeof createRunnerConfigurationRoutes>[0]["registry"];
  mcp?: (request: Request) => Promise<Response>;
  readiness?: Readonly<{ ready: () => boolean }>;
  outline?: Readonly<{
    authorization: OutlineProjectAuthorization;
    connector: Omit<
      Parameters<typeof createOutlineConnectorRoutes>[0],
      keyof OutlineHttpSecurity | keyof OutlineProjectAuthorization
    >;
    search: Omit<
      Parameters<typeof createOutlineSearchRoutes>[0],
      keyof OutlineHttpSecurity | keyof OutlineProjectAuthorization
    >;
    documents: Omit<
      Parameters<typeof createOutlineDocumentRoutes>[0],
      keyof OutlineHttpSecurity | keyof OutlineProjectAuthorization
    >;
  }>;
}>;

export function createFoundationHttpApp(dependencies: FoundationHttpDependencies): Hono {
  const app = new Hono();
  app.use("*", foundationSecurityHeaders());
  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  if (dependencies.deviceIdentity) {
    app.route(
      "/api/v1/device",
      createDeviceAuthRoutes({
        authority: dependencies.deviceIdentity,
        authentication: dependencies.authentication,
      }),
    );
  }
  if (dependencies.runnerPairing) {
    app.route(
      "/api/v1/runners/pairing",
      createRunnerPairingRoutes({
        registry: dependencies.runnerPairing,
        authentication: dependencies.authentication,
        runnerAuthentication: dependencies.runnerAuthentication,
      }),
    );
  }
  if (dependencies.runnerConfiguration) {
    app.route(
      "/api/v1/runners",
      createRunnerConfigurationRoutes({
        configuredOrigin: dependencies.configuredOrigin,
        authentication: dependencies.authentication,
        rateLimits: dependencies.rateLimits,
        registry: dependencies.runnerConfiguration,
      }),
    );
  }
  if (dependencies.browserIdentity) {
    app.route(
      "/api/v1",
      createBrowserAuthRoutes({
        configuredOrigin: dependencies.configuredOrigin,
        identity: dependencies.browserIdentity,
        rateLimits: dependencies.rateLimits,
      }),
    );
  }
  app.route("/api/v1/runs", createRunRoutes(dependencies));
  if (dependencies.outline) {
    const outlineSecurity = {
      authentication: dependencies.authentication,
      configuredOrigin: dependencies.configuredOrigin,
      rateLimits: dependencies.rateLimits,
    };
    app.route(
      "/api/v1/connectors/outline",
      createOutlineConnectorRoutes({
        ...dependencies.outline.connector,
        ...dependencies.outline.authorization,
        ...outlineSecurity,
      }),
    );
    app.route(
      "/api/v1/outline/search",
      createOutlineSearchRoutes({
        ...dependencies.outline.search,
        ...dependencies.outline.authorization,
        ...outlineSecurity,
      }),
    );
    app.route(
      "/api/v1/outline/documents",
      createOutlineDocumentRoutes({
        ...dependencies.outline.documents,
        ...dependencies.outline.authorization,
        ...outlineSecurity,
      }),
    );
  }
  if (dependencies.mcp) {
    const mcp = dependencies.mcp;
    app.all("/mcp", (context) => mcp(context.req.raw));
  }
  app.notFound((context) =>
    context.json(
      { error: { code: "NOT_FOUND", message: "The requested API resource does not exist." } },
      404,
    ),
  );
  return app;
}
