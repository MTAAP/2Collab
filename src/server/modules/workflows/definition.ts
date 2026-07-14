import { createHash } from "node:crypto";
import {
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from "../../../shared/contracts/workflow.ts";
import { stableJson } from "../templates/run-templates.ts";

export function semanticHash(definition: WorkflowDefinition): string {
  const parsed = WorkflowDefinitionSchema.parse(definition);
  return createHash("sha256").update(stableJson(parsed), "utf8").digest("hex");
}
