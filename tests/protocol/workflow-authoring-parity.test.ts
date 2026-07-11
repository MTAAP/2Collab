import { expect, test } from "bun:test";
import { workflowCommand } from "../../src/cli/commands/workflows.ts";
import { createWorkflowAuthoringOperations } from "../../src/server/modules/workflows/authoring.ts";
import { validDefinition, validLayout } from "../fixtures/workflows/valid.ts";

test("HTTP CLI and MCP authoring consume the same semantic operation", async () => {
  const calls: unknown[] = [];
  const operations = createWorkflowAuthoringOperations({
    saveDraft: async (command) => {
      calls.push(command);
      return {
        ok: true as const,
        value: {
          id: command.draftId,
          templateKey: command.templateKey,
          revision: 1,
          definition: command.definition,
          layout: command.layout,
          updatedByMemberId: command.actorMemberId,
          updatedAt: 1,
        },
      };
    },
  });
  const command = {
    idempotencyKey: "save_1",
    actorMemberId: "member_1",
    draftId: "draft_1",
    templateKey: "flow",
    expectedRevision: 0,
    definition: validDefinition,
    layout: validLayout,
  } as const;
  const direct = await operations.save(command);
  const cli = await workflowCommand(["save-draft", JSON.stringify(command)], operations);
  const mcp = await operations.save(command);
  expect(cli).toEqual(direct);
  expect(mcp).toEqual(direct);
  expect(calls).toHaveLength(3);
});
