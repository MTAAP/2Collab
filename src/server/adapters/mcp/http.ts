import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { PublicRunOperations } from "../../modules/public-surface/contract.ts";
import { createPublicMcpServer } from "./server.ts";

type Dependencies = Readonly<{
  authentication: Readonly<{
    authenticateDevice(request: Request): Promise<Result<MemberActor>>;
  }>;
  runs: PublicRunOperations;
  outlineMcp?: Readonly<{
    search(actor: MemberActor, input: unknown): Promise<unknown>;
    read(actor: MemberActor, input: unknown): Promise<unknown>;
  }>;
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
      ...(dependencies.outlineMcp ? { outline: dependencies.outlineMcp } : {}),
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}
