import type { Result } from "../../../shared/contracts/result.ts";
import type { OutlineContentPort } from "../../adapters/outline/contract.ts";
import type { AuthorizedScopedSearch, FederatedSearchResult } from "./contract.ts";

export function createFederatedSearch(outline: OutlineContentPort) {
  return {
    async search(command: AuthorizedScopedSearch): Promise<Result<FederatedSearchResult>> {
      return outline.search(command.scope, command.query);
    },
  };
}
