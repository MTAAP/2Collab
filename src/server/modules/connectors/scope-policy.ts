import type { ConnectorScope } from "./contract.ts";

export function connectorScopeAllows(
  scope: ConnectorScope,
  input: Readonly<{
    projectId: string;
    connectorId: string;
    connectorEpoch: number;
    reference: string;
    operation: string;
  }>,
): boolean {
  return (
    scope.projectId === input.projectId &&
    scope.connectorId === input.connectorId &&
    scope.connectorEpoch === input.connectorEpoch &&
    scope.references.includes(input.reference) &&
    scope.operations.includes(input.operation)
  );
}
