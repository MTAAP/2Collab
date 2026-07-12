import { Hono } from "hono";
import type { PublicAuthenticationPort } from "./middleware/authentication.ts";
import type {
  OutlineHttpSecurity,
  OutlineProjectAuthorization,
} from "./middleware/outline-security.ts";
import { enforceRateLimit, type PublicRateLimitPort } from "./middleware/request-limits.ts";
import type { PublicRunOperations } from "./public-schemas.ts";
import { createBrowserAuthRoutes } from "./routes/auth.ts";
import { createBetterAuthBootstrapRoutes } from "./routes/better-auth-bootstrap.ts";
import { createBetterAuthEmailOtpRoutes } from "./routes/better-auth-email-otp.ts";
import { createBetterAuthInvitationRoutes } from "./routes/better-auth-invitations.ts";
import { createOutlineConnectorRoutes } from "./routes/connectors-outline.ts";
import { createDeviceAuthRoutes } from "./routes/device-auth.ts";
import { createOutlineDocumentRoutes } from "./routes/outline-documents.ts";
import { createOutlineSearchRoutes } from "./routes/outline-search.ts";
import { createRunRoutes } from "./routes/runs.ts";
import { createRunnerPairingRoutes } from "./routes/runner-pairing.ts";
import { createRunnerConfigurationRoutes } from "./routes/runner-configuration.ts";
import { createRegistrationPolicyRoutes } from "./routes/registration-policy.ts";
import { foundationSecurityHeaders } from "./security-headers.ts";

const browserAuthSecretFields = new Set([
  "token",
  "accessToken",
  "refreshToken",
  "access_token",
  "refresh_token",
]);

function sanitizeBrowserAuthJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeBrowserAuthJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !browserAuthSecretFields.has(key))
      .map(([key, nested]) => [key, sanitizeBrowserAuthJson(nested)]),
  );
}

const publicBetterAuthEndpoints = new Set([
  "GET /api/auth/get-session",
  "GET /api/auth/passkey/generate-authenticate-options",
  "POST /api/auth/passkey/generate-authenticate-options",
  "GET /api/auth/passkey/generate-register-options",
  "POST /api/auth/passkey/generate-register-options",
  "POST /api/auth/passkey/verify-authentication",
  "POST /api/auth/passkey/verify-registration",
  "POST /api/auth/device/code",
  "POST /api/auth/device/token",
  "GET /api/auth/device",
  "POST /api/auth/device/approve",
]);

export type FoundationHttpDependencies = Readonly<{
  configuredOrigin: string;
  authentication: PublicAuthenticationPort;
  rateLimits: PublicRateLimitPort;
  runs: PublicRunOperations;
  browserIdentity?: Parameters<typeof createBrowserAuthRoutes>[0]["identity"];
  betterAuth?: Readonly<{
    handle(request: Request): Promise<Response>;
    bootstrap?: Parameters<typeof createBetterAuthBootstrapRoutes>[0];
    emailOtp?: Parameters<typeof createBetterAuthEmailOtpRoutes>[0];
    invitations?: Parameters<typeof createBetterAuthInvitationRoutes>[0];
  }>;
  deviceIdentity?: Parameters<typeof createDeviceAuthRoutes>[0]["authority"];
  runnerPairing?: Parameters<typeof createRunnerPairingRoutes>[0]["registry"];
  runnerAuthentication?: Parameters<typeof createRunnerPairingRoutes>[0]["runnerAuthentication"];
  runnerConfiguration?: Parameters<typeof createRunnerConfigurationRoutes>[0]["registry"];
  registrationPolicy?: Parameters<typeof createRegistrationPolicyRoutes>[0];
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
  if (dependencies.betterAuth) {
    const betterAuth = dependencies.betterAuth;
    app.on(["GET", "POST"], ["/api/auth/*"], async (context) => {
      if (!publicBetterAuthEndpoints.has(`${context.req.method} ${context.req.path}`))
        return context.notFound();
      if (
        context.req.path === "/api/auth/passkey/generate-authenticate-options" &&
        (context.req.header("sec-fetch-site") !== "same-origin" ||
          (context.req.header("origin") !== undefined &&
            context.req.header("origin") !== dependencies.configuredOrigin))
      )
        return context.json(
          {
            error: {
              code: "AUTH_ORIGIN_INVALID",
              message: "Authentication origin is invalid.",
            },
          },
          403,
        );
      const rateLimited = enforceRateLimit(context, dependencies.rateLimits, "PREAUTHENTICATED");
      if (rateLimited) return rateLimited;
      const response = await betterAuth.handle(context.req.raw);
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.set("pragma", "no-cache");
      headers.delete("set-auth-token");
      if (context.req.path === "/api/auth/device/token") {
        headers.delete("set-cookie");
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      }
      if (headers.get("content-type")?.includes("application/json")) {
        const body = sanitizeBrowserAuthJson(await response.json());
        headers.delete("content-length");
        return new Response(JSON.stringify(body), {
          status: response.status,
          headers,
        });
      }
      return new Response(response.body, { status: response.status, headers });
    });
    if (betterAuth.bootstrap)
      app.route("/api/v1", createBetterAuthBootstrapRoutes(betterAuth.bootstrap));
    if (betterAuth.emailOtp)
      app.route("/api/v1", createBetterAuthEmailOtpRoutes(betterAuth.emailOtp));
    if (betterAuth.invitations)
      app.route("/api/v1", createBetterAuthInvitationRoutes(betterAuth.invitations));
  }
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
  if (dependencies.registrationPolicy)
    app.route(
      "/api/v1/settings/auth",
      createRegistrationPolicyRoutes(dependencies.registrationPolicy),
    );
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
      {
        error: {
          code: "NOT_FOUND",
          message: "The requested API resource does not exist.",
        },
      },
      404,
    ),
  );
  return app;
}
