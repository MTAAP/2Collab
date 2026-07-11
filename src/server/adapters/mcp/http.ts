import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { PublicAuthenticationPort } from "../http/middleware/authentication.ts";
import type { PublicRunOperations } from "../http/public-schemas.ts";
import { createPublicMcpServer } from "./server.ts";

type Dependencies = Readonly<{
  authentication: PublicAuthenticationPort;
  runs: PublicRunOperations;
}>;

export function createMcpHttpHandler(dependencies: Dependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.headers.has("cookie") || request.headers.has("origin")) {
      return Response.json(
        {
          error: {
            code: "DEVICE_AUTHENTICATION_REQUIRED",
            message: "Device authentication is required.",
          },
        },
        { status: 401 },
      );
    }
    const authenticated = await dependencies.authentication.authenticateDevice(request);
    if (!authenticated.ok) return Response.json(authenticated, { status: 401 });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createPublicMcpServer({
      actor: authenticated.value,
      runs: dependencies.runs,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}
