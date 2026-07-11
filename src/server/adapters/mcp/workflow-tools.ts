import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CanvasLayoutSchema,
  WorkflowDefinitionSchema,
} from "../../../shared/contracts/workflow.ts";
import type { WorkflowAuthoringOperations } from "../../modules/workflows/authoring.ts";

const InputSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(128),
    actorMemberId: z.string().min(1).max(128),
    draftId: z.string().min(1).max(128),
    templateKey: z.string().min(1).max(128),
    expectedRevision: z.number().int().nonnegative(),
    definition: WorkflowDefinitionSchema,
    layout: CanvasLayoutSchema,
  })
  .strict();
const OutputSchema = z
  .object({ ok: z.boolean(), value: z.unknown().optional(), error: z.unknown().optional() })
  .strict();

export function registerWorkflowTools(
  server: McpServer,
  operations: WorkflowAuthoringOperations,
): void {
  server.registerTool(
    "collab_workflow_draft_save",
    {
      title: "Save Workflow Draft",
      description:
        "Save one optimistic revision of a canonical Workflow Definition and Canvas Layout.",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
    },
    async (command) => {
      const result = await operations.save(command);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );
}
