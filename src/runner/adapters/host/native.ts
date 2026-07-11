import type { TrustedHostPort } from "./contract.ts";
import { createTrustedExecutionHost } from "./trusted.ts";

export function createNativeExecutionHost(port: TrustedHostPort) {
  return createTrustedExecutionHost("NATIVE", port);
}
