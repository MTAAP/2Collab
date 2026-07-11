import type { Database } from "bun:sqlite";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";

type ConnectorEpoch = Readonly<{
  connectorId: string;
  epoch: number;
  reviewState: "READY" | "REVIEW_REQUIRED" | "REVOKED";
  revision: number;
}>;

function failure(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

export function readConnectorEpoch(database: Database, connectorId: string): ConnectorEpoch | null {
  const row = database
    .query<
      Readonly<{
        connector_id: string;
        epoch: number;
        review_state: ConnectorEpoch["reviewState"];
        revision: number;
      }>,
      [string]
    >(
      "SELECT connector_id, epoch, review_state, revision FROM connector_epochs WHERE connector_id = ?",
    )
    .get(connectorId);
  return row
    ? {
        connectorId: row.connector_id,
        epoch: row.epoch,
        reviewState: row.review_state,
        revision: row.revision,
      }
    : null;
}

export function advanceConnectorEpoch(
  database: Database,
  input: Readonly<{
    connectorId: string;
    expectedEpoch: number;
    reviewState: "READY" | "REVIEW_REQUIRED" | "REVOKED";
  }>,
): Result<ConnectorEpoch> {
  return inImmediateTransaction(database, () => {
    const changed = database
      .query<void, [string, string, number]>(
        "UPDATE connector_epochs SET epoch = epoch + 1, review_state = ?, revision = revision + 1 WHERE connector_id = ? AND epoch = ?",
      )
      .run(input.reviewState, input.connectorId, input.expectedEpoch);
    if (changed.changes !== 1) return failure("CONNECTOR_EPOCH_STALE", "Connector epoch is stale.");
    const value = readConnectorEpoch(database, input.connectorId);
    return value ? { ok: true, value } : failure("CONNECTOR_NOT_FOUND", "Connector was not found.");
  });
}
