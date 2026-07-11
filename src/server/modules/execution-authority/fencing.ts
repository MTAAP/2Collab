import type { Database } from "bun:sqlite";
import type { Result } from "../../../shared/contracts/result.ts";
import type { AuthoritySessionView } from "../../../shared/contracts/runs.ts";
import { error } from "./policy.ts";

export type SessionContext = Readonly<{
  id: string;
  attemptId: string;
  runId: string;
  runnerId: string;
  runnerEpoch: number;
  fence: number;
  repositoryMode: "MUTATING" | "INSPECT_ONLY";
  repositoryAssurance: "ADVISORY" | "ENFORCED";
  issuedAt: number;
  expiresAt: number;
  sessionSeconds: number;
  renewalSeconds: number;
  disconnectGraceSeconds: number;
  deadlineAt: number;
  connectorEpochs: Readonly<Record<string, number>>;
  lease?: Readonly<{
    id: string;
    fence: number;
    expiresAt: number;
    disconnectGraceExpiresAt: number;
  }>;
}>;

export function readSession(database: Database, sessionId: string): SessionContext | undefined {
  const row = database
    .query<
      {
        id: string;
        attempt_id: string;
        run_id: string;
        runner_id: string;
        runner_epoch: number;
        fence: number;
        repository_mode: "MUTATING" | "INSPECT_ONLY";
        repository_assurance: "ADVISORY" | "ENFORCED";
        issued_at: number;
        expires_at: number;
        state: string;
        authority_session_seconds: number;
        authority_renewal_seconds: number;
        mutation_disconnect_grace_seconds: number;
        deadline_at: number;
      },
      [string]
    >(
      `SELECT s.id, s.attempt_id, a.run_id, s.runner_id, s.runner_epoch, s.fence,
              s.repository_mode, s.repository_assurance, s.issued_at, s.expires_at, s.state,
              p.authority_session_seconds, p.authority_renewal_seconds,
              p.mutation_disconnect_grace_seconds, p.deadline_at
       FROM authority_sessions s
       JOIN execution_attempts a ON a.id = s.attempt_id
       JOIN run_execution_policies p ON p.run_id = a.run_id
       WHERE s.id = ?`,
    )
    .get(sessionId);
  if (row?.state !== "ACTIVE") return undefined;
  const connectorEpochs = Object.fromEntries(
    database
      .query<{ connector_id: string; connector_epoch: number }, [string]>(
        "SELECT connector_id, connector_epoch FROM authority_session_connector_epochs WHERE session_id = ?",
      )
      .all(sessionId)
      .map((epoch) => [epoch.connector_id, epoch.connector_epoch]),
  );
  const lease = database
    .query<
      { id: string; fence: number; expires_at: number; disconnect_grace_expires_at: number },
      [string]
    >(
      `SELECT id, fence, expires_at, disconnect_grace_expires_at
       FROM mutation_leases WHERE session_id = ? AND state = 'ACTIVE'`,
    )
    .get(sessionId);
  return {
    id: row.id,
    attemptId: row.attempt_id,
    runId: row.run_id,
    runnerId: row.runner_id,
    runnerEpoch: row.runner_epoch,
    fence: row.fence,
    repositoryMode: row.repository_mode,
    repositoryAssurance: row.repository_assurance,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    sessionSeconds: row.authority_session_seconds,
    renewalSeconds: row.authority_renewal_seconds,
    disconnectGraceSeconds: row.mutation_disconnect_grace_seconds,
    deadlineAt: row.deadline_at,
    connectorEpochs,
    ...(lease
      ? {
          lease: {
            id: lease.id,
            fence: lease.fence,
            expiresAt: lease.expires_at,
            disconnectGraceExpiresAt: lease.disconnect_grace_expires_at,
          },
        }
      : {}),
  };
}

export function requireSessionFence(
  database: Database,
  sessionId: string,
  expectedFence: number,
  now: number,
): Result<SessionContext> {
  const session = readSession(database, sessionId);
  if (!session) return error("AUTHORITY_SESSION_INACTIVE", "Authority Session is inactive.");
  if (session.fence !== expectedFence) {
    return error("SESSION_FENCE_STALE", "Authority Session fence is stale.", "REFRESH");
  }
  if (now >= session.expiresAt || now >= session.deadlineAt) {
    return error("AUTHORITY_SESSION_EXPIRED", "Authority Session expired.", "EXPLICIT_RESUME");
  }
  return { ok: true, value: session };
}

export function sessionView(session: SessionContext): AuthoritySessionView {
  return {
    id: session.id as never,
    attemptId: session.attemptId as never,
    fence: session.fence,
    issuedAt: session.issuedAt as never,
    expiresAt: session.expiresAt as never,
    repositoryMode: session.repositoryMode,
    repositoryAssurance: session.repositoryAssurance,
    connectorEpochs: session.connectorEpochs as never,
    ...(session.repositoryMode === "MUTATING" && session.lease
      ? {
          mutationLease: {
            leaseId: session.lease.id as never,
            fence: session.lease.fence,
            expiresAt: session.lease.expiresAt as never,
          },
        }
      : {}),
  } as AuthoritySessionView;
}

export interface OperationAuthorizationConsumer {
  consume(
    input: Readonly<{
      authorizationId: string;
      operationDigest: string;
      sessionId: string;
      sessionFence: number;
    }>,
  ): Result<Readonly<{ consumedAt: number }>>;
}

export function createOperationAuthorizationConsumer(
  database: Database,
  clock: () => number,
): OperationAuthorizationConsumer {
  return {
    consume(input) {
      const now = clock();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = database
          .query<
            {
              state: string;
              operation_digest: string;
              session_id: string;
              session_fence: number;
              mutation_lease_fence: number | null;
              connector_id: string | null;
              connector_epoch: number | null;
              connector_scope_id: string | null;
              connector_scope_revision: number | null;
              connector_operation: string | null;
              expires_at: number;
            },
            [string]
          >(
            `SELECT state, operation_digest, session_id, session_fence,
                    mutation_lease_fence, connector_id, connector_epoch,
                    connector_scope_id, connector_scope_revision, connector_operation, expires_at
             FROM operation_authorizations WHERE id = ?`,
          )
          .get(input.authorizationId);
        if (
          !row ||
          row.operation_digest !== input.operationDigest ||
          row.session_id !== input.sessionId
        ) {
          database.exec("COMMIT");
          return error("OPERATION_AUTHORIZATION_INVALID", "Operation authorization is invalid.");
        }
        if (row.state === "CONSUMED") {
          database.exec("COMMIT");
          return error(
            "OPERATION_AUTHORIZATION_REPLAYED",
            "Operation authorization was already consumed.",
          );
        }
        if (row.state === "REVOKED") {
          database.exec("COMMIT");
          return error("OPERATION_AUTHORIZATION_REVOKED", "Operation authorization was revoked.");
        }
        if (row.state === "EXPIRED" || now >= row.expires_at) {
          database
            .query(
              "UPDATE operation_authorizations SET state = 'EXPIRED', revision = revision + 1 WHERE id = ? AND state = 'ISSUED'",
            )
            .run(input.authorizationId);
          database.exec("COMMIT");
          return error("OPERATION_AUTHORIZATION_EXPIRED", "Operation authorization expired.");
        }
        const session = readSession(database, input.sessionId);
        if (
          !session ||
          session.fence !== input.sessionFence ||
          row.session_fence !== session.fence
        ) {
          database.exec("COMMIT");
          return error("SESSION_FENCE_STALE", "Authority Session fence is stale.", "REFRESH");
        }
        const runner = database
          .query<{ runner_epoch: number; revoked_at: number | null }, [string]>(
            "SELECT runner_epoch, revoked_at FROM runners WHERE id = ?",
          )
          .get(session.runnerId);
        if (!runner || runner.revoked_at !== null || runner.runner_epoch !== session.runnerEpoch) {
          database.exec("COMMIT");
          return error("RUNNER_EPOCH_CHANGED", "Runner authority changed.", "REFRESH");
        }
        if (row.connector_id !== null) {
          const connector = database
            .query<{ epoch: number; review_state: string }, [string]>(
              "SELECT epoch, review_state FROM connector_epochs WHERE connector_id = ?",
            )
            .get(row.connector_id);
          const scope = database
            .query<{ count: number }, [string, number, string, string]>(
              `SELECT count(*) AS count FROM connector_scopes s
               JOIN connector_scope_operations o ON o.scope_id = s.id
               WHERE s.id = ? AND s.revision = ? AND s.revoked_at IS NULL AND o.operation = ?
                 AND s.connector_id = ?`,
            )
            .get(
              row.connector_scope_id ?? "",
              row.connector_scope_revision ?? 0,
              row.connector_operation ?? "",
              row.connector_id,
            );
          if (
            connector?.review_state !== "READY" ||
            connector.epoch !== row.connector_epoch ||
            session.connectorEpochs[row.connector_id] !== row.connector_epoch ||
            scope?.count !== 1
          ) {
            database.exec("COMMIT");
            return error("CONNECTOR_REVOKED", "Connector authority changed.", "REFRESH");
          }
        }
        if (
          row.mutation_lease_fence !== null &&
          (!session.lease ||
            row.mutation_lease_fence !== session.lease.fence ||
            now >= session.lease.expiresAt)
        ) {
          database.exec("COMMIT");
          return error("MUTATION_LEASE_LOST", "Mutation lease expired.", "EXPLICIT_RESUME");
        }
        const changed = database
          .query(
            `UPDATE operation_authorizations
             SET state = 'CONSUMED', consumed_at = ?, revision = revision + 1
             WHERE id = ? AND state = 'ISSUED' AND operation_digest = ?`,
          )
          .run(now, input.authorizationId, input.operationDigest);
        database.exec("COMMIT");
        return changed.changes === 1
          ? { ok: true, value: { consumedAt: now } }
          : error(
              "OPERATION_AUTHORIZATION_REPLAYED",
              "Operation authorization was already consumed.",
            );
      } catch {
        database.exec("ROLLBACK");
        return error(
          "OPERATION_AUTHORIZATION_STORAGE_FAILED",
          "Operation authorization failed.",
          "SAME_INPUT",
        );
      }
    },
  };
}
