import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import { WorkflowStepResultSchema } from "../../../shared/contracts/workflow-results.ts";
import type { WorkflowRuntimeOperations } from "../../modules/workflows/runtime-operations.ts";

const Identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const Output = z
  .object({ ok: z.boolean(), value: z.unknown().optional(), error: z.unknown().optional() })
  .strict();
const Start = z
  .object({
    idempotencyKey: Identifier,
    workflowExecutionId: Identifier,
    coordinationRecordId: Identifier,
    coordinationRevision: z.number().int().positive(),
    templateVersionId: Identifier,
    presetVersionId: Identifier,
    inputs: z
      .record(
        z.string().min(1).max(64),
        z.union([z.string().max(16_384), z.number().finite(), z.boolean()]),
      )
      .optional(),
    workflowPresetId: Identifier,
    workflowPresetVersion: z.number().int().positive(),
  })
  .strict();
const Show = z.object({ workflowExecutionId: Identifier }).strict();
const Control = z
  .object({
    idempotencyKey: Identifier,
    workflowExecutionId: Identifier,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const Decision = z
  .object({
    decisionId: Identifier,
    workflowExecutionId: Identifier,
    nodeKey: Identifier,
    choice: z.string().min(1).max(128),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const Event = z
  .object({
    eventId: Identifier,
    workflowExecutionId: Identifier,
    expectedRevision: z.number().int().positive(),
    stepOccurrenceId: Identifier,
    runId: Identifier,
    result: WorkflowStepResultSchema,
  })
  .strict();

export function registerWorkflowRuntimeTools(
  server: McpServer,
  actor: MemberActor,
  operations: WorkflowRuntimeOperations,
): void {
  const register = <T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    invoke: (command: z.infer<T>) => Promise<unknown>,
  ) =>
    server.registerTool(
      name,
      { title: name, description, inputSchema: schema, outputSchema: Output },
      (async (command: unknown) => {
        const result = (await invoke(command as z.infer<T>)) as Record<string, unknown>;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
          ...(result.ok === false ? { isError: true } : {}),
        };
      }) as never,
    );
  register("collab_workflow_start", "Start a stored Workflow Execution.", Start, (command) =>
    operations.start(actor, command as never),
  );
  register("collab_workflow_show", "Show an owned Workflow Execution.", Show, (command) =>
    operations.show(actor, command.workflowExecutionId),
  );
  for (const action of ["pause", "resume", "cancel"] as const)
    register(
      `collab_workflow_${action}`,
      `${action} an owned Workflow Execution.`,
      Control,
      (command) => operations[action](actor, command),
    );
  register("collab_workflow_decide", "Record a human Workflow decision.", Decision, (command) =>
    operations.decide(actor, command),
  );
  register("collab_workflow_event", "Record one typed Workflow step event.", Event, (command) =>
    operations.event(actor, command),
  );
}
