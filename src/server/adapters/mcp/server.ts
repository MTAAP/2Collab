import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { PublicRunOperations } from "../../modules/public-surface/contract.ts";
import { bindPublicRunOperations, registerPublicRunTools } from "./tools.ts";
import { bindGitHubMutationClient, registerGitHubTools } from "./github-tools.ts";
import type { GitHubMutation, GitHubProjection } from "../../../shared/contracts/github.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { ExactRevisionMutation, Observed } from "../../modules/connectors/contract.ts";

export function createPublicMcpServer(dependencies: {
  actor: MemberActor;
  runs: PublicRunOperations;
  github?: Readonly<{
    mutate(
      actor: MemberActor,
      command: ExactRevisionMutation<GitHubMutation>,
    ): Promise<Result<Observed<GitHubProjection>>>;
  }>;
}): McpServer {
  const server = new McpServer({ name: "2collab", version: "0.1.0" });
  registerPublicRunTools(server, {
    runs: bindPublicRunOperations(dependencies.actor, dependencies.runs),
  });
  if (dependencies.github) {
    registerGitHubTools(
      server,
      bindGitHubMutationClient(
        (command) =>
          dependencies.github?.mutate(dependencies.actor, command) ??
          Promise.resolve({
            ok: false,
            error: {
              code: "GITHUB_NOT_CONFIGURED",
              message: "GitHub is not configured.",
              retry: "NEVER",
            },
          }),
      ),
    );
  }
  return server;
}
