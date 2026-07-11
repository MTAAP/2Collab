import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { PublicRunOperations } from "../../modules/public-surface/contract.ts";
import { createPublicMcpServer } from "./server.ts";
import type { GitHubMutation, GitHubProjection } from "../../../shared/contracts/github.ts";
import type { ExactRevisionMutation, Observed } from "../../modules/connectors/contract.ts";

type Dependencies = Readonly<{
  authentication: Readonly<{
    authenticateDevice(request: Request): Promise<Result<MemberActor>>;
  }>;
  runs: PublicRunOperations;
  github?: Readonly<{
    mutate(
      actor: MemberActor,
      command: ExactRevisionMutation<GitHubMutation>,
    ): Promise<Result<Observed<GitHubProjection>>>;
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
      github: dependencies.github,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}
