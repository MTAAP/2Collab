import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  GitHubMutationSchema,
  GitHubProjectionSchema,
  type GitHubMutation,
  type GitHubProjection,
} from "../../../shared/contracts/github.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import { DomainErrorSchema } from "../../../shared/contracts/result.ts";
import {
  ExactRevisionMutationSchema,
  ObservedSchema,
  type ExactRevisionMutation,
  type Observed,
} from "../../modules/connectors/contract.ts";

const outputSchema = z
  .object({
    ok: z.boolean(),
    value: ObservedSchema(GitHubProjectionSchema).optional(),
    error: DomainErrorSchema.optional(),
  })
  .strict();
export type GitHubMutationClient = Readonly<{
  mutate(
    command: ExactRevisionMutation<GitHubMutation>,
  ): Promise<Result<Observed<GitHubProjection>>>;
}>;

export function registerGitHubTools(server: McpServer, client: GitHubMutationClient): void {
  server.registerTool(
    "collab_github_mutate",
    {
      title: "Mutate selected GitHub work",
      description: "Perform one closed, exact-revision GitHub mutation.",
      inputSchema: ExactRevisionMutationSchema(GitHubMutationSchema),
      outputSchema,
    },
    async (command) => {
      const result = await client.mutate(command as ExactRevisionMutation<GitHubMutation>);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );
}

export function bindGitHubMutationClient(
  mutate: GitHubMutationClient["mutate"],
): GitHubMutationClient {
  return { mutate };
}
