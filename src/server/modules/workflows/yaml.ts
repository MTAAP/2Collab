import { parseDocument, stringify } from "yaml";
import {
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from "../../../shared/contracts/workflow.ts";

const forbiddenImportKeys = new Set([
  "personalRunPresetId",
  "runnerId",
  "profileVersionId",
  "command",
  "environment",
  "credential",
  "reactFlowNodes",
  "reactFlowEdges",
]);

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) => forbiddenImportKeys.has(key) || containsForbiddenKey(item),
  );
}

export function importWorkflowYaml(source: string): WorkflowDefinition {
  if (source.length === 0 || source.length > 1_000_000) throw new Error("WORKFLOW_YAML_INVALID");
  const document = parseDocument(source, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) throw new Error("WORKFLOW_YAML_INVALID");
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (containsForbiddenKey(value)) throw new Error("WORKFLOW_IMPORT_PRIVATE_DATA");
  const parsed = WorkflowDefinitionSchema.safeParse(value);
  if (!parsed.success) throw new Error("WORKFLOW_DEFINITION_INVALID");
  return parsed.data;
}

export function exportWorkflowYaml(definition: WorkflowDefinition): string {
  return stringify(WorkflowDefinitionSchema.parse(definition), { sortMapEntries: true });
}
