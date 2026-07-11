import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { GitHubMutation, GitHubProjection } from "../../../shared/contracts/github.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { ExactRevisionMutation, Observed } from "../../modules/connectors/contract.ts";
import type { PublicRunOperations } from "../../modules/public-surface/contract.ts";
import type { TemplateBindingOperations } from "../../modules/templates/bindings.ts";
import type { WorkflowAuthoringOperations } from "../../modules/workflows/authoring.ts";
import type { WorkflowRuntimeOperations } from "../../modules/workflows/runtime-operations.ts";
import { bindGitHubMutationClient, registerGitHubTools } from "./github-tools.ts";
import { registerOutlineTools } from "./outline-tools.ts";
import { registerTemplateTools } from "./template-tools.ts";
import { bindPublicRunOperations, registerPublicRunTools } from "./tools.ts";
import { registerWorkflowRuntimeTools } from "./workflow-runtime-tools.ts";
import { registerWorkflowTools } from "./workflow-tools.ts";

export function createPublicMcpServer(dependencies: {
  actor: MemberActor;
  runs: PublicRunOperations;
  outline?: Readonly<{
    search(actor: MemberActor, input: unknown): Promise<unknown>;
    read(actor: MemberActor, input: unknown): Promise<unknown>;
  }>;
  github?: Readonly<{
    mutate(
      actor: MemberActor,
      command: ExactRevisionMutation<GitHubMutation>,
    ): Promise<Result<Observed<GitHubProjection>>>;
  }>;
  workflows?: WorkflowAuthoringOperations;
  templates?: TemplateBindingOperations;
  workflowRuntime?: WorkflowRuntimeOperations;
}): McpServer {
  const server = new McpServer({ name: "2collab", version: "0.1.0" });
  registerPublicRunTools(server, {
    runs: bindPublicRunOperations(dependencies.actor, dependencies.runs),
  });
  if (dependencies.outline) registerOutlineTools(server, dependencies.actor, dependencies.outline);
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
  if (dependencies.workflows)
    registerWorkflowTools(server, dependencies.actor, dependencies.workflows);
  if (dependencies.templates)
    registerTemplateTools(server, dependencies.actor, dependencies.templates);
  if (dependencies.workflowRuntime)
    registerWorkflowRuntimeTools(server, dependencies.actor, dependencies.workflowRuntime);
  return server;
}
