import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TemplateBindingOperations } from "../../modules/templates/bindings.ts";

const InputSchema = z
  .object({ idempotencyKey: z.string().min(1).max(128), actorMemberId: z.string().min(1).max(128) })
  .passthrough();
const OutputSchema = z
  .object({ ok: z.boolean(), value: z.unknown().optional(), error: z.unknown().optional() })
  .strict();

export function registerTemplateTools(
  server: McpServer,
  operations: TemplateBindingOperations,
): void {
  server.registerTool(
    "collab_workflow_preset_bind",
    {
      title: "Bind Personal Workflow Preset",
      description: "Bind exact Personal Run Preset versions without substitution.",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
    },
    async (command) => {
      const result = await operations.bind(command);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );
}
