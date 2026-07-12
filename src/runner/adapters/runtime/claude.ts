import { createBundledExecutionAdapter } from "./bundled.ts";

export function createClaudeExecutionAdapter() {
  return createBundledExecutionAdapter("CLAUDE", "claude");
}
