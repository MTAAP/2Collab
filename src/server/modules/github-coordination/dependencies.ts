import type { SourceDependency } from "../../../shared/contracts/github.ts";
import type { Observed } from "../connectors/contract.ts";

export type SourceDependencyView = Readonly<{
  freshness: Observed<unknown>["freshness"];
  dependencies: readonly SourceDependency[];
  blocksLaunch: false;
  changesRunState: false;
}>;
export const dependencyWarning = (
  value: Observed<readonly SourceDependency[]>,
): SourceDependencyView => ({
  freshness: value.freshness,
  dependencies: value.value,
  blocksLaunch: false,
  changesRunState: false,
});
