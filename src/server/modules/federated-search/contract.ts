import type { OutlineReference } from "../../../shared/contracts/outline.ts";
import type { ConnectorScope, EphemeralSearchPage, ScopedSearch } from "../connectors/contract.ts";

export type AuthorizedOutlineActor =
  | Readonly<{ kind: "MEMBER"; memberId: string }>
  | Readonly<{ kind: "RUN_ATTEMPT"; runId: string; attemptId: string }>;

export type AuthorizedScopedSearch = Readonly<{
  actor: AuthorizedOutlineActor;
  scope: ConnectorScope;
  query: ScopedSearch;
}>;

export type FederatedSearchResult = EphemeralSearchPage<OutlineReference>;
