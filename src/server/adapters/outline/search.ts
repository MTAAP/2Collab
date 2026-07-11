import type { Result } from "../../../shared/contracts/result.ts";
import type { OutlineReference } from "../../../shared/contracts/outline.ts";
import type {
  ConnectorScope,
  EphemeralSearchPage,
  ScopedSearch,
} from "../../modules/connectors/contract.ts";
import type { OutlineContentPort } from "./contract.ts";

export async function searchOutline(
  content: OutlineContentPort,
  scope: ConnectorScope,
  query: ScopedSearch,
): Promise<Result<EphemeralSearchPage<OutlineReference>>> {
  return content.search(scope, query);
}
