import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OutlineReferenceSchema } from "../../../shared/contracts/outline.ts";
import { ScopedSearchSchema } from "../../modules/connectors/contract.ts";

export function registerOutlineTools(
  server: McpServer,
  dependencies: Readonly<{
    search(input: unknown): Promise<unknown>;
    read(input: unknown): Promise<unknown>;
  }>,
): void {
  server.registerTool(
    "collab_outline_search",
    {
      title: "Search Outline",
      description: "Search current scoped Outline documents.",
      inputSchema: z.object({ query: ScopedSearchSchema }).strict(),
    },
    async (input) => ({
      content: [{ type: "text" as const, text: JSON.stringify(await dependencies.search(input)) }],
    }),
  );
  server.registerTool(
    "collab_outline_read",
    {
      title: "Read Outline document",
      description: "Read one current scoped Outline document.",
      inputSchema: z.object({ reference: OutlineReferenceSchema }).strict(),
    },
    async (input) => ({
      content: [{ type: "text" as const, text: JSON.stringify(await dependencies.read(input)) }],
    }),
  );
}
