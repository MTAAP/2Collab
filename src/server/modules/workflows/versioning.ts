import { createHash } from "node:crypto";
import { CanvasLayoutSchema, type CanvasLayout } from "../../../shared/contracts/workflow.ts";
import { stableJson } from "../templates/run-templates.ts";

export function layoutHash(layout: CanvasLayout): string {
  const parsed = CanvasLayoutSchema.parse(layout);
  return createHash("sha256").update(stableJson(parsed), "utf8").digest("hex");
}
