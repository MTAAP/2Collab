import type { Database } from "bun:sqlite";
import type { Result } from "../../../shared/contracts/result.ts";
import type { ConnectorScope } from "../connectors/contract.ts";

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  scope(projectId: string, connectorId: string): Result<ConnectorScope>;
  reconcile(
    scope: ConnectorScope,
    cursor: string | undefined,
    onProgress: (cursor: string) => void,
  ): Promise<Result<unknown>>;
}>;

export function createGitHubDurableWorker(dependencies: Dependencies) {
  const runScope = async (
    projectId: string,
    connectorId: string,
    cursor?: string,
    persistProgress = false,
  ) => {
    const scope = dependencies.scope(projectId, connectorId);
    if (!scope.ok) return scope;
    return dependencies.reconcile(scope.value, cursor, (next) => {
      if (!persistProgress) return;
      dependencies.database
        .query(
          `UPDATE github_reconciliation_cursors SET cursor = ?, revision = revision + 1 WHERE project_id = ? AND connector_id = ? AND resource_family = 'REPOSITORIES'`,
        )
        .run(next, projectId, connectorId);
    });
  };
  type CursorRow = Readonly<{
    project_id: string;
    connector_id: string;
    cursor: string | null;
  }>;
  const runCursorRow = async (row: CursorRow): Promise<boolean> => {
    dependencies.database
      .query(
        `UPDATE github_reconciliation_cursors SET status = 'SCANNING', revision = revision + 1 WHERE project_id = ? AND connector_id = ? AND resource_family = 'REPOSITORIES'`,
      )
      .run(row.project_id, row.connector_id);
    const result = await runScope(row.project_id, row.connector_id, row.cursor ?? undefined, true);
    if (!result.ok) {
      dependencies.database
        .query(
          `UPDATE github_reconciliation_cursors SET status = 'FAILED_RETRYABLE', not_before = ?, revision = revision + 1 WHERE project_id = ? AND connector_id = ? AND resource_family = 'REPOSITORIES'`,
        )
        .run(dependencies.clock() + 60, row.project_id, row.connector_id);
      return false;
    }
    dependencies.database
      .query(
        `UPDATE github_reconciliation_cursors SET status = 'IDLE', cursor = NULL, last_complete_at = ?, not_before = NULL, revision = revision + 1 WHERE project_id = ? AND connector_id = ? AND resource_family = 'REPOSITORIES'`,
      )
      .run(dependencies.clock(), row.project_id, row.connector_id);
    return true;
  };
  return {
    async consumePendingWebhookApplications(): Promise<Result<Readonly<{ applied: number }>>> {
      const rows = dependencies.database
        .query<
          { connector_id: string; hook_id: string; delivery_id: string; project_id: string },
          []
        >(
          `SELECT connector_id, hook_id, delivery_id, project_id FROM github_webhook_applications WHERE outcome IN ('PENDING','FAILED_RETRYABLE') ORDER BY connector_id, delivery_id, project_id`,
        )
        .all();
      let applied = 0;
      for (const row of rows) {
        const reconciled = await runScope(row.project_id, row.connector_id);
        if (!reconciled.ok) {
          dependencies.database
            .query(
              `UPDATE github_webhook_applications SET outcome = 'FAILED_RETRYABLE', revision = revision + 1 WHERE connector_id = ? AND hook_id = ? AND delivery_id = ? AND project_id = ?`,
            )
            .run(row.connector_id, row.hook_id, row.delivery_id, row.project_id);
          continue;
        }
        dependencies.database.transaction(() => {
          dependencies.database
            .query(
              `UPDATE github_webhook_applications SET outcome = 'APPLIED', revision = revision + 1 WHERE connector_id = ? AND hook_id = ? AND delivery_id = ? AND project_id = ?`,
            )
            .run(row.connector_id, row.hook_id, row.delivery_id, row.project_id);
          dependencies.database
            .query(
              `UPDATE github_webhook_deliveries SET applied_at = ? WHERE connector_id = ? AND hook_id = ? AND delivery_id = ? AND NOT EXISTS (SELECT 1 FROM github_webhook_applications WHERE connector_id = ? AND hook_id = ? AND delivery_id = ? AND outcome <> 'APPLIED')`,
            )
            .run(
              dependencies.clock(),
              row.connector_id,
              row.hook_id,
              row.delivery_id,
              row.connector_id,
              row.hook_id,
              row.delivery_id,
            );
        })();
        applied += 1;
      }
      return { ok: true, value: { applied } };
    },
    async runReconciliation(
      projectId: string,
      connectorId: string,
    ): Promise<Result<Readonly<{ completed: boolean }>>> {
      const row = dependencies.database
        .query<CursorRow, [string, string, number]>(
          `SELECT project_id, connector_id, cursor FROM github_reconciliation_cursors
           WHERE project_id = ? AND connector_id = ? AND resource_family = 'REPOSITORIES'
             AND (not_before IS NULL OR not_before <= ?)`,
        )
        .get(projectId, connectorId, dependencies.clock());
      return { ok: true, value: { completed: row ? await runCursorRow(row) : false } };
    },
    async runDueReconciliation(): Promise<Result<Readonly<{ completed: number }>>> {
      const rows = dependencies.database
        .query<CursorRow, [number]>(
          `SELECT project_id, connector_id, cursor FROM github_reconciliation_cursors WHERE resource_family = 'REPOSITORIES' AND (not_before IS NULL OR not_before <= ?) ORDER BY project_id, connector_id`,
        )
        .all(dependencies.clock());
      let completed = 0;
      for (const row of rows) {
        if (await runCursorRow(row)) completed += 1;
      }
      return { ok: true, value: { completed } };
    },
  };
}
