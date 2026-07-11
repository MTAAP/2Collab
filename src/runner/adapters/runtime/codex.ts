import { createBundledExecutionAdapter } from "./bundled.ts";

export function createCodexExecutionAdapter() {
  return createBundledExecutionAdapter("CODEX", "codex");
}
