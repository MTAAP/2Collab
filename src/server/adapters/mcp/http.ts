import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { GitHubMutation, GitHubProjection } from "../../../shared/contracts/github.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { ExactRevisionMutation, Observed } from "../../modules/connectors/contract.ts";
import type { PublicRunOperations } from "../../modules/public-surface/contract.ts";
import type { TemplateBindingOperations } from "../../modules/templates/bindings.ts";
import type { WorkflowAuthoringOperations } from "../../modules/workflows/authoring.ts";
import type { WorkflowRuntimeOperations } from "../../modules/workflows/runtime-operations.ts";
import { createPublicMcpServer } from "./server.ts";

type McpRateLimitPort = Readonly<{
  allow(input: Readonly<{ actorId: string; method: string; path: string }>): boolean;
}>;

type Dependencies = Readonly<{
  authentication: Readonly<{
    authenticateDevice(request: Request): Promise<Result<MemberActor>>;
  }>;
  workflows?: WorkflowAuthoringOperations;
  templates?: TemplateBindingOperations;
  workflowRuntime?: WorkflowRuntimeOperations;
  rateLimits?: McpRateLimitPort;
  runs: PublicRunOperations;
  outlineMcp?: Readonly<{
    search(actor: MemberActor, input: unknown): Promise<unknown>;
    read(actor: MemberActor, input: unknown): Promise<unknown>;
  }>;
  github?: Readonly<{
    mutate(
      actor: MemberActor,
      command: ExactRevisionMutation<GitHubMutation>,
    ): Promise<Result<Observed<GitHubProjection>>>;
  }>;
}>;

export function createMcpHttpHandler(dependencies: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const declaredLength = request.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > 64 * 1024)
    ) {
      return Response.json(
        { error: { code: "REQUEST_TOO_LARGE", message: "The request body is too large." } },
        { status: 413 },
      );
    }
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
    if (
      dependencies.rateLimits &&
      !dependencies.rateLimits.allow({
        actorId: authenticated.value.memberId,
        method: request.method,
        path: "/mcp",
      })
    )
      return Response.json(
        { error: { code: "RATE_LIMITED", message: "Request rate limit exceeded." } },
        { status: 429 },
      );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createPublicMcpServer({
      actor: authenticated.value,
      runs: dependencies.runs,
      ...(dependencies.outlineMcp ? { outline: dependencies.outlineMcp } : {}),
      github: dependencies.github,
      workflows: dependencies.workflows,
      templates: dependencies.templates,
      workflowRuntime: dependencies.workflowRuntime,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}
