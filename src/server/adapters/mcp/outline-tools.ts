import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import { IdentifierSchema } from "../../../shared/contracts/ids.ts";
import { OutlineReferenceSchema } from "../../../shared/contracts/outline.ts";
import { ScopedSearchSchema } from "../../modules/connectors/contract.ts";

export function registerOutlineTools(
  server: McpServer,
  actor: MemberActor,
  dependencies: Readonly<{
    search(actor: MemberActor, input: unknown): Promise<unknown>;
    read(actor: MemberActor, input: unknown): Promise<unknown>;
  }>,
): void {
  server.registerTool(
    "collab_outline_search",
    {
      title: "Search Outline",
      description: "Search current scoped Outline documents.",
      inputSchema: z
        .object({
          projectId: IdentifierSchema,
          connectorId: IdentifierSchema,
          query: ScopedSearchSchema,
        })
        .strict(),
    },
    async (input) => ({
      content: [
        { type: "text" as const, text: JSON.stringify(await dependencies.search(actor, input)) },
      ],
    }),
  );
  server.registerTool(
    "collab_outline_read",
    {
      title: "Read Outline document",
      description: "Read one current scoped Outline document.",
      inputSchema: z
        .object({
          projectId: IdentifierSchema,
          connectorId: IdentifierSchema,
          reference: OutlineReferenceSchema,
        })
        .strict(),
    },
    async (input) => ({
      content: [
        { type: "text" as const, text: JSON.stringify(await dependencies.read(actor, input)) },
      ],
    }),
  );
}
