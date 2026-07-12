import type { OutlineReadResult, OutlineReference } from "../../../shared/contracts/outline.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { ConnectorScope, EphemeralObserved } from "../../modules/connectors/contract.ts";
import type { OutlineContentPort } from "./contract.ts";

export async function readOutlineDocument(
  content: OutlineContentPort,
  scope: ConnectorScope,
  reference: OutlineReference,
): Promise<Result<EphemeralObserved<OutlineReadResult>>> {
  return content.read(scope, reference);
}
