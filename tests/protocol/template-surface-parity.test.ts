import { expect, test } from "bun:test";
import { templateCommand } from "../../src/cli/commands/templates.ts";
import type { TemplateBindingOperations } from "../../src/server/modules/templates/bindings.ts";

test("CLI and shared template surfaces return the same binding result", async () => {
  const value = {
    ok: false as const,
    error: {
      code: "PRESET_BINDING_REQUIRED",
      message: "A binding is stale.",
      retry: "EXPLICIT_RESUME" as const,
    },
  };
  const operations: TemplateBindingOperations = { bind: async () => value };
  const command = { idempotencyKey: "bind_1", actorMemberId: "member_1" };
  expect(await templateCommand(["bind", JSON.stringify(command)], operations)).toEqual(value);
  expect(await operations.bind(command)).toEqual(value);
});
