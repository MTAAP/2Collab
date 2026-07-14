import { createHash } from "node:crypto";
import { stableJson } from "../templates/run-templates.ts";

export function workflowDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export function workflowIdempotencyKey(
  workflowExecutionId: string,
  stepOccurrenceId: string,
): string {
  return `workflow-${workflowExecutionId}-${stepOccurrenceId}`;
}
