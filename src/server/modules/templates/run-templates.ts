import { createHash } from "node:crypto";
import {
  TeamRunTemplateDraftSchema,
  type TeamRunTemplateDraft,
} from "../../../shared/contracts/templates.ts";

const forbiddenTemplateKeys = new Set([
  "privateRunnerId",
  "personalRunPresetId",
  "profileVersionId",
  "executable",
  "arguments",
  "environment",
  "credential",
  "documentWriteGrantId",
]);

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sanitizeRunTemplate(input: unknown): TeamRunTemplateDraft {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("TEMPLATE_INVALID");
  }
  for (const key of Object.keys(input)) {
    if (forbiddenTemplateKeys.has(key)) throw new Error("TEMPLATE_PRIVATE_EXECUTION_DATA");
  }
  const parsed = TeamRunTemplateDraftSchema.safeParse(input);
  if (!parsed.success) throw new Error("TEMPLATE_INVALID");
  return parsed.data;
}

export function runTemplateHash(definition: TeamRunTemplateDraft): string {
  return createHash("sha256").update(stableJson(definition), "utf8").digest("hex");
}
