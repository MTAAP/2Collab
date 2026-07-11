import type { Database } from "bun:sqlite";

type ConnectorEpoch = Readonly<{
  connectorId: string;
  epoch: number;
  reviewState: "READY" | "REVIEW_REQUIRED" | "REVOKED";
  revision: number;
}>;

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
