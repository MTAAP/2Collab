import type { Result } from "../../../shared/contracts/result.ts";
import type { GitHubProjection } from "../../../shared/contracts/github.ts";
import type { GitHubPort } from "./contract.ts";
import type { ConnectorScope, Observed, ReconciliationCursor, ReconciliationEvent } from "../../modules/connectors/contract.ts";

export type ReconciliationSummary = Readonly<{
  scanned: number;
  updated: number;
  unchanged: number;
  cursor?: string;
}>;

export type GitHubReconciliationAuthority = Readonly<{
  reconcileSource(event: ReconciliationEvent<GitHubProjection>): Result<Observed<GitHubProjection>>;
}>;

export async function reconcileGitHubScope(input: Readonly<{
  github: GitHubPort;
  connectorAuthority: GitHubReconciliationAuthority;
  scope: ConnectorScope;
  cursor?: ReconciliationCursor;
}>): Promise<Result<ReconciliationSummary>> {
  let scanned = 0;
  let updated = 0;
  let unchanged = 0;
  for await (const event of input.github.scan(input.scope, input.cursor)) {
    if (!event.ok) return event;
    scanned += 1;
    const applied = input.connectorAuthority.reconcileSource(event.value);
    if (!applied.ok) return applied;
    if (applied.value.projectionRevision > 1) updated += 1;
    else unchanged += 1;
  }
  return { ok: true, value: { scanned, updated, unchanged, ...(input.cursor ? { cursor: input.cursor } : {}) } };
}
