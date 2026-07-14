import type { TrustedHostPort } from "./contract.ts";
import { createTrustedExecutionHost } from "./trusted.ts";

export function createOrcaExecutionHost(port: TrustedHostPort) {
  return createTrustedExecutionHost("ORCA", port);
}
