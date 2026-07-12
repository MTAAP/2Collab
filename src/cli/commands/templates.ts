import type { TemplateBindingOperations } from "../../server/modules/templates/bindings.ts";

export async function templateCommand(
  args: readonly string[],
  operations: TemplateBindingOperations,
) {
  if (args.length !== 2 || args[0] !== "bind") throw new Error("TEMPLATE_ARGUMENTS_INVALID");
  try {
    return operations.bind(JSON.parse(args[1] as string) as unknown);
  } catch {
    throw new Error("TEMPLATE_ARGUMENTS_INVALID");
  }
}
