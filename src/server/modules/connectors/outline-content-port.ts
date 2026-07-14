import type { Result } from "../../../shared/contracts/result.ts";
import type {
  OutlineDocumentProjection,
  OutlineMutation,
  OutlineReadResult,
  OutlineReference,
} from "../../../shared/contracts/outline.ts";
import type {
  ConnectorScope,
  ContextConnector,
  Observed,
  ReconciliationCursor,
  ReconciliationEvent,
} from "./contract.ts";

export interface OutlineContentPort
  extends ContextConnector<
    OutlineReference,
    OutlineReadResult,
    OutlineDocumentProjection,
    OutlineMutation
  > {}

export interface OutlineReconciliationPort {
  inspectSafe(
    scope: ConnectorScope,
    reference: OutlineReference,
  ): Promise<Result<Observed<OutlineDocumentProjection>>>;
  scanSafe(
    scope: ConnectorScope,
    cursor?: ReconciliationCursor,
  ): AsyncIterable<Result<ReconciliationEvent<OutlineDocumentProjection>>>;
}
