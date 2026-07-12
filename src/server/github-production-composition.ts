import type { Database } from "bun:sqlite";
import type { PublicAuthenticationPort } from "./adapters/http/middleware/authentication.ts";
import type { PublicRateLimitPort } from "./adapters/http/middleware/request-limits.ts";
import type { GitHubWebhookRouteDependencies } from "./adapters/http/routes/connectors-github.ts";
import type { ServerResources } from "./dependencies.ts";
import type { ProjectionCodec, ConnectorScope } from "./modules/connectors/contract.ts";
import {
  createConnectorAuthority,
  type AttemptOperationAuthorityPort,
} from "./modules/connectors/connector-authority.ts";
import type { PublicRunOperations } from "./modules/public-surface/contract.ts";
import type { GitHubPort } from "./modules/github-coordination/contract.ts";
import { createGitHubDurableWorker } from "./modules/github-coordination/durable-worker.ts";
import { createGitHubReconciliationScheduler } from "./modules/github-coordination/reconciliation-scheduler.ts";
import { createGitHubCoordinationService } from "./modules/github-coordination/service.ts";
import type { Result } from "../shared/contracts/result.ts";

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
  digest: (value: string) => Promise<Uint8Array>;
  attemptAuthority: AttemptOperationAuthorityPort;
  projectionCodec: (connectorId: string) => ProjectionCodec<unknown>;
  github: GitHubPort;
  authentication: PublicAuthenticationPort;
  rateLimits: PublicRateLimitPort;
  runs: PublicRunOperations;
  configuredOrigin: string;
  webhooks: GitHubWebhookRouteDependencies;
  planning: NonNullable<ServerResources["github"]>["planning"];
  inbox: NonNullable<ServerResources["inbox"]>;
  scope(projectId: string, connectorId: string): Result<ConnectorScope>;
  reconcile(
    scope: ConnectorScope,
    cursor: string | undefined,
    onProgress: (cursor: string) => void,
  ): Promise<Result<unknown>>;
  reconciliationIntervalMs?: number;
  maximumBackoffMs?: number;
}>;

/** Import-safe assembly of every GitHub delivery surface around one authority and one port. */
export function createGitHubProductionComposition(dependencies: Dependencies): Readonly<{
  resources: ServerResources;
  worker: ReturnType<typeof createGitHubDurableWorker>;
  scheduler: ReturnType<typeof createGitHubReconciliationScheduler>;
  service: ReturnType<typeof createGitHubCoordinationService>;
}> {
  const connectorAuthority = createConnectorAuthority({
    database: dependencies.database,
    clock: dependencies.clock,
    id: dependencies.id,
    digest: dependencies.digest,
    attemptAuthority: dependencies.attemptAuthority,
    projectionCodec: dependencies.projectionCodec,
  });
  const service = createGitHubCoordinationService({
    database: dependencies.database,
    clock: dependencies.clock,
    github: dependencies.github,
    connectorAuthority,
  });
  const mutate = service.mutate;
  const worker = createGitHubDurableWorker({
    database: dependencies.database,
    clock: dependencies.clock,
    scope: dependencies.scope,
    reconcile: dependencies.reconcile,
  });
  const scheduler = createGitHubReconciliationScheduler({
    clock: dependencies.clock,
    intervalMs: dependencies.reconciliationIntervalMs ?? 300_000,
    maximumBackoffMs: dependencies.maximumBackoffMs ?? 3_600_000,
    scopes: () =>
      dependencies.database
        .query<{ project_id: string; connector_id: string }, [number]>(
          `SELECT project_id, connector_id FROM github_reconciliation_cursors
           WHERE resource_family = 'REPOSITORIES' AND (not_before IS NULL OR not_before <= ?)
           ORDER BY project_id, connector_id`,
        )
        .all(dependencies.clock())
        .flatMap((row) => {
          const scope = dependencies.scope(row.project_id, row.connector_id);
          return scope.ok ? [scope.value] : [];
        }),
    reconcile: async (scope) => {
      const result = await worker.runReconciliation(scope.projectId, scope.connectorId);
      return result.ok ? { ok: true, value: {} } : result;
    },
  });
  return {
    worker,
    scheduler,
    service,
    resources: {
      foundation: {
        authentication: dependencies.authentication,
        rateLimits: dependencies.rateLimits,
        runs: dependencies.runs,
      },
      github: {
        webhooks: dependencies.webhooks,
        issues: {
          authentication: dependencies.authentication,
          rateLimits: dependencies.rateLimits,
          configuredOrigin: dependencies.configuredOrigin,
          mutate,
        },
        planning: dependencies.planning,
        mcp: { mutate },
      },
      inbox: dependencies.inbox,
      startup: async () => {
        await worker.consumePendingWebhookApplications();
        scheduler.start();
      },
    },
  };
}
