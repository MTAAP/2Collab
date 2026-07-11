import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import {
  type BrowserSessionAuthorityFacts,
  createBrowserSessionAuthority,
} from "../identity/browser-session-authority.ts";
import type {
  ConnectorOperationAuthorization,
  ConnectorScope,
  ExactRevisionMutation,
  Observed,
  ProjectionCodec,
  ReconciliationEvent,
  SourceConnector,
} from "./contract.ts";
import { connectorScopeAllows } from "./scope-policy.ts";

export interface AttemptOperationAuthorityPort {
  verify(
    input: Readonly<{
      authorizationId: string;
      authorizationProof: string;
      projectId: string;
      connectorId: string;
      connectorEpoch: number;
      reference: string;
      operation: string;
      actionDigest: string;
    }>,
  ): Promise<Result<Readonly<{ actorId: string }>>>;
  consume(
    input: Readonly<{
      authorizationId: string;
      authorizationProof: string;
      projectId: string;
      connectorId: string;
      connectorEpoch: number;
      reference: string;
      operation: string;
      actionDigest: string;
    }>,
  ): Promise<Result<Readonly<{ consumed: true }>>>;
}

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
  digest: (value: string) => Promise<Uint8Array>;
  attemptAuthority: AttemptOperationAuthorityPort;
  projectionCodec: (connectorId: string) => ProjectionCodec<unknown>;
  randomSecret?: () => string;
  beforeConfirmationCommit?: () => void;
}>;

type MutationInput<M> = Readonly<{
  reference: string;
  operation: string;
  command: ExactRevisionMutation<M>;
}>;

type MemberMutationInput<M> = MutationInput<M> & Readonly<{ actor: MemberActor }>;
type AttemptMutationInput<M> = MutationInput<M> &
  Readonly<{ authorizationId: string; authorizationProof: string }>;

type ScopeRow = Readonly<{
  id: string;
  project_id: string;
  connector_id: string;
  connector_epoch: number;
  revision: number;
  epoch: number;
  review_state: "READY" | "REVIEW_REQUIRED" | "REVOKED";
}>;

type ProjectionRow = Readonly<{
  source_revision: string;
  comparable_digest: string;
  projection_revision: number;
}>;

function error(
  code: string,
  message: string,
  retry: "NEVER" | "SAME_INPUT" | "REFRESH" = "NEVER",
): Result<never> {
  return { ok: false, error: { code, message, retry } };
}

function validBounded(value: string, maximum: number): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}

function canonicalInputHash(value: unknown): string | null {
  const seen = new Set<object>();
  let nodes = 0;
  const normalize = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 2_048 || depth > 16) throw new Error("INVALID");
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("INVALID");
      return candidate;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > 512 || seen.has(candidate)) throw new Error("INVALID");
      seen.add(candidate);
      const result = candidate.map((item) => normalize(item, depth + 1));
      seen.delete(candidate);
      return result;
    }
    if (typeof candidate !== "object" || Object.getPrototypeOf(candidate) !== Object.prototype)
      throw new Error("INVALID");
    if (seen.has(candidate)) throw new Error("INVALID");
    seen.add(candidate);
    const keys = Object.keys(candidate as Record<string, unknown>);
    if (keys.length > 512) throw new Error("INVALID");
    keys.sort();
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (key.length > 256) throw new Error("INVALID");
      result[key] = normalize((candidate as Record<string, unknown>)[key], depth + 1);
    }
    seen.delete(candidate);
    return result;
  };
  try {
    const serialized = JSON.stringify(normalize(value, 0));
    if (Buffer.byteLength(serialized, "utf8") > 65_536) return null;
    return createHash("sha256").update(serialized, "utf8").digest("hex");
  } catch {
    return null;
  }
}

function observedIsBounded(value: Observed<unknown>): boolean {
  try {
    const serialized = JSON.stringify(value.value);
    return (
      validBounded(value.reference, 256) &&
      validBounded(value.sourceRevision, 128) &&
      /^[a-f0-9]{64}$/.test(value.comparableDigest) &&
      Number.isInteger(value.observedAt) &&
      value.observedAt >= 0 &&
      Buffer.byteLength(serialized, "utf8") <= 65_536 &&
      value.provenance.projectId.length <= 128 &&
      value.provenance.connectorId.length <= 128
    );
  } catch {
    return false;
  }
}

export function createConnectorAuthority(dependencies: Dependencies) {
  const { database, clock } = dependencies;
  const browserSessions = createBrowserSessionAuthority(dependencies);

  const scopeSnapshot = (projectId: string, connectorId: string): ScopeRow | null =>
    database
      .query<ScopeRow, [string, string]>(
        `SELECT connector_scopes.id, connector_scopes.project_id, connector_scopes.connector_id,
                connector_scopes.connector_epoch, connector_scopes.revision,
                connector_epochs.epoch, connector_epochs.review_state
         FROM connector_scopes JOIN connector_epochs
           ON connector_epochs.connector_id = connector_scopes.connector_id
         WHERE connector_scopes.project_id = ? AND connector_scopes.connector_id = ?
           AND connector_scopes.revoked_at IS NULL`,
      )
      .get(projectId, connectorId);

  const scopeFrom = (row: ScopeRow): ConnectorScope => ({
    projectId: row.project_id as never,
    connectorId: row.connector_id as never,
    connectorEpoch: row.connector_epoch,
    references: database
      .query<{ reference: string }, [string]>(
        "SELECT reference FROM connector_scope_references WHERE scope_id = ? ORDER BY reference",
      )
      .all(row.id)
      .map((item) => item.reference),
    operations: database
      .query<{ operation: string }, [string]>(
        "SELECT operation FROM connector_scope_operations WHERE scope_id = ? ORDER BY operation",
      )
      .all(row.id)
      .map((item) => item.operation),
  });

  const projection = (input: MutationInput<unknown>): ProjectionRow | null =>
    database
      .query<ProjectionRow, [string, string, string]>(
        `SELECT source_revision, comparable_digest, projection_revision
         FROM connector_projections
         WHERE project_id = ? AND connector_id = ? AND reference = ?`,
      )
      .get(input.command.projectId, input.command.connectorId, input.reference);

  const validateInput = <M>(
    input: MutationInput<M>,
  ): Result<Readonly<{ scope: ScopeRow; projection: ProjectionRow | null }>> => {
    const command = input.command;
    if (
      !validBounded(input.reference, 256) ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.operation) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(command.idempotencyKey) ||
      !/^[a-f0-9]{64}$/.test(command.actionDigest)
    ) {
      return error("CONNECTOR_INPUT_INVALID", "Connector input is invalid.");
    }
    const row = scopeSnapshot(command.projectId, command.connectorId);
    if (
      row?.review_state !== "READY" ||
      row.epoch !== command.connectorEpoch ||
      row.connector_epoch !== command.connectorEpoch ||
      !connectorScopeAllows(scopeFrom(row), {
        projectId: command.projectId,
        connectorId: command.connectorId,
        connectorEpoch: command.connectorEpoch,
        reference: input.reference,
        operation: input.operation,
      })
    ) {
      return error("CONNECTOR_AUTHORITY_DENIED", "Connector authority is denied.");
    }
    const currentProjection = projection(input);
    if (command.precondition.kind === "ABSENT") {
      if (currentProjection)
        return error("SOURCE_REVISION_STALE", "Source revision is stale.", "REFRESH");
    } else if (
      !currentProjection ||
      currentProjection.source_revision !== command.precondition.sourceRevision ||
      currentProjection.comparable_digest !== command.precondition.comparableDigest
    ) {
      return error("SOURCE_REVISION_STALE", "Source revision is stale.", "REFRESH");
    }
    return { ok: true, value: { scope: row, projection: currentProjection } };
  };

  const issueAuthorization = async <M>(
    actorKind: "MEMBER" | "ATTEMPT",
    actorId: string,
    input: MutationInput<M>,
    snapshot: Readonly<{ scope: ScopeRow; projection: ProjectionRow | null }>,
    inputHash: string,
    browser?: BrowserSessionAuthorityFacts,
  ): Promise<Result<ConnectorOperationAuthorization>> => {
    const proof = dependencies.randomSecret?.() ?? randomBytes(32).toString("base64url");
    const proofHash = await dependencies.digest(proof);
    const id = dependencies.id("connector_authorization");
    const expiresAt = clock() + 60;
    try {
      return inImmediateTransaction(database, () => {
        const currentScope = scopeSnapshot(input.command.projectId, input.command.connectorId);
        const currentProjection = projection(input);
        if (
          !currentScope ||
          currentScope.epoch !== snapshot.scope.epoch ||
          currentScope.revision !== snapshot.scope.revision ||
          currentScope.review_state !== "READY" ||
          (snapshot.projection === null
            ? currentProjection !== null
            : !currentProjection ||
              currentProjection.projection_revision !== snapshot.projection.projection_revision)
        ) {
          return error("CONNECTOR_AUTHORITY_STALE", "Connector authority changed.", "REFRESH");
        }
        if (browser && !browserSessions.revalidate(browser).ok)
          return error("CONNECTOR_AUTHORITY_STALE", "Connector authority changed.", "REFRESH");
        const actionMarker = `${input.operation}:${input.reference}:${input.command.idempotencyKey}`;
        const actorBindingDigest = createHash("sha256")
          .update(
            `${actorKind}:${actorId}:${input.command.projectId}:${input.command.connectorId}:${input.command.connectorEpoch}:${input.command.actionDigest}`,
            "utf8",
          )
          .digest("hex");
        const precondition = input.command.precondition;
        database
          .query(
            `INSERT INTO connector_operation_intents(
               id, actor_id, actor_kind, operation, idempotency_key, input_hash, action_marker,
               actor_binding_digest, project_id, connector_id, connector_epoch, scope_revision,
               reference, precondition_kind, source_revision, comparable_digest, member_key,
               expected_present, action_digest, state, attempt_count, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                       'PENDING', 1, ?, ?)`,
          )
          .run(
            id,
            actorId,
            actorKind,
            input.operation,
            input.command.idempotencyKey,
            inputHash,
            actionMarker,
            actorBindingDigest,
            input.command.projectId,
            input.command.connectorId,
            input.command.connectorEpoch,
            snapshot.scope.revision,
            input.reference,
            precondition.kind,
            precondition.kind === "ABSENT" ? null : precondition.sourceRevision,
            precondition.kind === "ABSENT" ? null : precondition.comparableDigest,
            precondition.kind === "EXPECTED_MEMBERSHIP" ? precondition.memberKey : null,
            precondition.kind === "EXPECTED_MEMBERSHIP" ? Number(precondition.present) : null,
            input.command.actionDigest,
            clock(),
            clock(),
          );
        database
          .query<
            void,
            [
              string,
              Uint8Array,
              string,
              string,
              number,
              number,
              string,
              string,
              string,
              string,
              string,
              number,
              number,
            ]
          >(
            `INSERT INTO connector_operation_authorizations(
               id, proof_hash, project_id, connector_id, connector_epoch, scope_revision,
               reference, operation, action_digest, actor_kind, actor_id, state, created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?)`,
          )
          .run(
            id,
            proofHash,
            input.command.projectId,
            input.command.connectorId,
            input.command.connectorEpoch,
            snapshot.scope.revision,
            input.reference,
            input.operation,
            input.command.actionDigest,
            actorKind,
            actorId,
            clock(),
            expiresAt,
          );
        return {
          ok: true,
          value: {
            kind: "CONNECTOR_OPERATION",
            id,
            proof,
            projectId: input.command.projectId,
            connectorId: input.command.connectorId,
            connectorEpoch: input.command.connectorEpoch,
            reference: input.reference,
            operation: input.operation,
            actionDigest: input.command.actionDigest,
            expiresAt,
          },
        };
      });
    } catch {
      return error("CONNECTOR_OPERATION_FAILED", "Connector operation failed.");
    }
  };

  const mutate = async <R, P, M>(
    connector: SourceConnector<R, P, M>,
    actorKind: "MEMBER" | "ATTEMPT",
    actorId: string,
    input: MutationInput<M>,
    authority?: Readonly<{
      browser?: BrowserSessionAuthorityFacts;
      consumeAttempt?: () => Promise<Result<Readonly<{ consumed: true }>>>;
    }>,
  ): Promise<Result<Observed<P>>> => {
    const inputHash = canonicalInputHash({
      reference: input.reference,
      operation: input.operation,
      command: input.command,
    });
    if (!inputHash) return error("CONNECTOR_INPUT_INVALID", "Connector input is invalid.");
    const codec = dependencies.projectionCodec(input.command.connectorId) as ProjectionCodec<P>;
    const stored = database
      .query<{ input_hash: string; result_json: string }, [string, string]>(
        "SELECT input_hash, result_json FROM connector_idempotency WHERE actor_id = ? AND idempotency_key = ?",
      )
      .get(actorId, input.command.idempotencyKey);
    if (stored) {
      if (stored.input_hash !== inputHash)
        return error("IDEMPOTENCY_CONFLICT", "Idempotency key was used with different input.");
      try {
        const parsed = JSON.parse(stored.result_json) as Omit<Observed<P>, "value"> & {
          projectionJson: string;
          auditId: string;
        };
        const projection = codec.deserialize(parsed.projectionJson);
        if (!projection.ok)
          return error("IDEMPOTENCY_STORAGE_INVALID", "Stored idempotency result is invalid.");
        const { projectionJson: _, auditId, ...metadata } = parsed;
        return { ok: true, value: { ...metadata, value: projection.value }, auditId };
      } catch {
        return error("IDEMPOTENCY_STORAGE_INVALID", "Stored idempotency result is invalid.");
      }
    }
    const pending = database
      .query<{ input_hash: string; state: string }, [string, string]>(
        "SELECT input_hash, state FROM connector_operation_intents WHERE actor_id = ? AND idempotency_key = ?",
      )
      .get(actorId, input.command.idempotencyKey);
    if (pending) {
      if (pending.input_hash !== inputHash)
        return error("IDEMPOTENCY_CONFLICT", "Idempotency key was used with different input.");
      return error(
        pending.state === "REQUIRES_REAUTHORIZATION"
          ? "CONNECTOR_REAUTHORIZATION_REQUIRED"
          : "CONNECTOR_OPERATION_PENDING",
        pending.state === "REQUIRES_REAUTHORIZATION"
          ? "Connector operation requires reauthorization."
          : "Connector operation outcome is pending reconciliation.",
        "REFRESH",
      );
    }
    const valid = validateInput(input);
    if (!valid.ok) return valid;
    if (authority?.browser && !browserSessions.revalidate(authority.browser).ok)
      return error("CONNECTOR_AUTHORITY_STALE", "Connector authority changed.", "REFRESH");
    if (authority?.consumeAttempt) {
      const consumed = await authority.consumeAttempt();
      if (!consumed.ok) return consumed;
    }
    const authorization = await issueAuthorization(
      actorKind,
      actorId,
      input,
      valid.value,
      inputHash,
      authority?.browser,
    );
    if (!authorization.ok) return authorization;
    let providerResult: Result<Observed<P>>;
    try {
      providerResult = await connector.mutate(authorization.value, input.command);
    } catch {
      return error("CONNECTOR_PROVIDER_FAILED", "Connector provider operation failed.", "REFRESH");
    }
    if (!providerResult.ok) {
      if (providerResult.error.retry === "NEVER") {
        try {
          inImmediateTransaction(database, () => {
            database
              .query(
                "UPDATE connector_operation_intents SET state = 'FAILED_PERMANENT', updated_at = ? WHERE id = ? AND state = 'PENDING'",
              )
              .run(clock(), authorization.value.id);
            database
              .query(
                "UPDATE connector_operation_authorizations SET state = 'REVOKED' WHERE id = ? AND state = 'RESERVED'",
              )
              .run(authorization.value.id);
          });
        } catch {
          return error("CONNECTOR_OPERATION_FAILED", "Connector operation failed.");
        }
      }
      return providerResult;
    }
    if (
      !observedIsBounded(providerResult.value) ||
      (providerResult.value.reference !== input.reference &&
        input.command.precondition.kind !== "ABSENT") ||
      providerResult.value.provenance.projectId !== input.command.projectId ||
      providerResult.value.provenance.connectorId !== input.command.connectorId ||
      providerResult.value.provenance.connectorEpoch !== input.command.connectorEpoch
    ) {
      return error(
        "CONNECTOR_PROVIDER_RESPONSE_INVALID",
        "Connector provider response is invalid.",
      );
    }
    const encodedProjection = codec.serialize(providerResult.value.value);
    if (!encodedProjection.ok)
      return error(
        "CONNECTOR_PROVIDER_RESPONSE_INVALID",
        "Connector provider response is invalid.",
      );
    try {
      return inImmediateTransaction(database, () => {
        const currentScope = scopeSnapshot(input.command.projectId, input.command.connectorId);
        const currentProjection = projection(input);
        if (
          !currentScope ||
          currentScope.epoch !== valid.value.scope.epoch ||
          currentScope.revision !== valid.value.scope.revision ||
          currentScope.review_state !== "READY" ||
          (valid.value.projection === null
            ? currentProjection !== null
            : !currentProjection ||
              currentProjection.projection_revision !== valid.value.projection.projection_revision)
        ) {
          database
            .query(
              "UPDATE connector_operation_intents SET state = 'REQUIRES_REAUTHORIZATION', updated_at = ? WHERE id = ? AND state = 'PENDING'",
            )
            .run(clock(), authorization.value.id);
          database
            .query(
              "UPDATE connector_operation_authorizations SET state = 'REVOKED' WHERE id = ? AND state = 'RESERVED'",
            )
            .run(authorization.value.id);
          return error("CONNECTOR_AUTHORITY_STALE", "Connector authority changed.", "REFRESH");
        }
        if (authority?.browser && !browserSessions.revalidate(authority.browser).ok) {
          database
            .query(
              "UPDATE connector_operation_intents SET state = 'REQUIRES_REAUTHORIZATION', updated_at = ? WHERE id = ? AND state = 'PENDING'",
            )
            .run(clock(), authorization.value.id);
          database
            .query(
              "UPDATE connector_operation_authorizations SET state = 'REVOKED' WHERE id = ? AND state = 'RESERVED'",
            )
            .run(authorization.value.id);
          return error("CONNECTOR_AUTHORITY_STALE", "Connector authority changed.", "REFRESH");
        }
        const nextProjection = (currentProjection?.projection_revision ?? 0) + 1;
        const observed: Observed<P> = {
          ...providerResult.value,
          projectionRevision: nextProjection,
        };
        const targetProjection = database
          .query<{ projection_revision: number }, [string, string, string]>(
            `SELECT projection_revision FROM connector_projections
             WHERE project_id = ? AND connector_id = ? AND reference = ?`,
          )
          .get(input.command.projectId, input.command.connectorId, observed.reference);
        if (observed.reference !== input.reference && targetProjection) {
          return error(
            "CONNECTOR_PROVIDER_RESPONSE_INVALID",
            "Connector provider response is invalid.",
          );
        }
        dependencies.beforeConfirmationCommit?.();
        const auditId = dependencies.id("audit");
        database
          .query<
            void,
            [
              string,
              string,
              string,
              number,
              string,
              string,
              number,
              number,
              number | null,
              string,
              string,
              string | null,
              string,
            ]
          >(
            `INSERT INTO connector_projections(
               project_id, connector_id, reference, connector_epoch, source_revision,
               comparable_digest, projection_revision, observed_at, source_updated_at,
               freshness, provenance_kind, provider_actor_id, projection_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id, connector_id, reference) DO UPDATE SET
               connector_epoch = excluded.connector_epoch,
               source_revision = excluded.source_revision,
               comparable_digest = excluded.comparable_digest,
               projection_revision = excluded.projection_revision,
               observed_at = excluded.observed_at,
               source_updated_at = excluded.source_updated_at,
               freshness = excluded.freshness,
               provenance_kind = excluded.provenance_kind,
               provider_actor_id = excluded.provider_actor_id,
               projection_json = excluded.projection_json`,
          )
          .run(
            input.command.projectId,
            input.command.connectorId,
            observed.reference,
            input.command.connectorEpoch,
            observed.sourceRevision,
            observed.comparableDigest,
            nextProjection,
            observed.observedAt,
            observed.sourceUpdatedAt ?? null,
            observed.freshness,
            observed.provenance.kind,
            observed.provenance.providerActorId ?? null,
            encodedProjection.value,
          );
        database
          .query<void, [string, string, string, string, string | null, number, string]>(
            `UPDATE connector_operation_intents SET
               state = 'COMMITTED', provider_reference = ?, provider_source_revision = ?,
               provider_comparable_digest = ?, provenance_kind = ?, provider_actor_id = ?,
               updated_at = ? WHERE id = ? AND state = 'PENDING'`,
          )
          .run(
            observed.reference,
            observed.sourceRevision,
            observed.comparableDigest,
            observed.provenance.kind,
            observed.provenance.providerActorId ?? null,
            clock(),
            authorization.value.id,
          );
        database
          .query<void, [number, string]>(
            "UPDATE connector_operation_authorizations SET state = 'CONSUMED', consumed_at = ? WHERE id = ? AND state = 'RESERVED'",
          )
          .run(clock(), authorization.value.id);
        database
          .query<void, [string, string, string, string, number]>(
            "INSERT INTO connector_idempotency(actor_id, idempotency_key, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            actorId,
            input.command.idempotencyKey,
            inputHash,
            JSON.stringify({
              ...observed,
              value: undefined,
              projectionJson: encodedProjection.value,
              auditId,
            }),
            clock(),
          );
        database
          .query<void, [string, string, string, string, string, number]>(
            "INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at) VALUES (?, 'CONNECTOR_MUTATION_CONFIRMED', ?, ?, ?, ?, ?)",
          )
          .run(
            auditId,
            actorKind,
            actorId,
            input.command.connectorId,
            JSON.stringify({ operation: input.operation, disposition: "CONFIRMED" }),
            clock(),
          );
        return { ok: true, value: observed, auditId };
      });
    } catch {
      return error("CONNECTOR_OPERATION_FAILED", "Connector operation failed.");
    }
  };

  const applyReconciliation = <P>(event: ReconciliationEvent<P>): Result<Observed<P>> => {
    if (
      !validBounded(event.reference, 256) ||
      !validBounded(event.sourceRevision, 128) ||
      !/^[a-f0-9]{64}$/.test(event.comparableDigest) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(event.idempotencyKey) ||
      !Number.isInteger(event.observedAt) ||
      event.observedAt < 0
    ) {
      return error("RECONCILIATION_INPUT_INVALID", "Reconciliation input is invalid.");
    }
    const codec = dependencies.projectionCodec(event.connectorId) as ProjectionCodec<P>;
    const encodedProjection = codec.serialize(event.value);
    if (!encodedProjection.ok)
      return error("RECONCILIATION_INPUT_INVALID", "Reconciliation input is invalid.");
    const inputHash = canonicalInputHash({ ...event, value: encodedProjection.value });
    if (!inputHash)
      return error("RECONCILIATION_INPUT_INVALID", "Reconciliation input is invalid.");
    const scope = scopeSnapshot(event.projectId, event.connectorId);
    if (
      scope?.review_state !== "READY" ||
      scope.epoch !== event.connectorEpoch ||
      scope.connector_epoch !== event.connectorEpoch ||
      !scopeFrom(scope).references.includes(event.reference)
    ) {
      return error("CONNECTOR_AUTHORITY_DENIED", "Connector authority is denied.");
    }
    const stored = database
      .query<{ input_hash: string; result_revision: number }, [string, string, number, string]>(
        `SELECT input_hash, result_revision FROM source_reconciliation_idempotency
         WHERE project_id = ? AND connector_id = ? AND connector_epoch = ? AND idempotency_key = ?`,
      )
      .get(event.projectId, event.connectorId, event.connectorEpoch, event.idempotencyKey);
    if (stored && stored.input_hash !== inputHash)
      return error("IDEMPOTENCY_CONFLICT", "Idempotency key was used with different input.");
    const current = database
      .query<
        ProjectionRow & {
          projection_json: string;
          observed_at: number;
          freshness: Observed<P>["freshness"];
          provenance_kind: Observed<P>["provenance"]["kind"];
          provider_actor_id: string | null;
          source_updated_at: number | null;
        },
        [string, string, string]
      >(
        `SELECT source_revision, comparable_digest, projection_revision, projection_json,
                observed_at, freshness, provenance_kind, provider_actor_id, source_updated_at
         FROM connector_projections WHERE project_id = ? AND connector_id = ? AND reference = ?`,
      )
      .get(event.projectId, event.connectorId, event.reference);
    const reconciliationActorId = `RECONCILIATION_${event.projectId}_${event.connectorId}_${event.connectorEpoch}`;
    const immutableResult = stored
      ? database
          .query<{ input_hash: string; result_json: string }, [string, string]>(
            "SELECT input_hash, result_json FROM connector_idempotency WHERE actor_id = ? AND idempotency_key = ?",
          )
          .get(reconciliationActorId, event.idempotencyKey)
      : null;
    if (stored) {
      try {
        if (!immutableResult || immutableResult.input_hash !== inputHash)
          return error("IDEMPOTENCY_STORAGE_INVALID", "Stored idempotency result is invalid.");
        const parsed = JSON.parse(immutableResult.result_json) as Omit<Observed<P>, "value"> & {
          projectionJson: string;
          auditId: string;
        };
        const persistedProjection = codec.deserialize(parsed.projectionJson);
        if (!persistedProjection.ok)
          return error("IDEMPOTENCY_STORAGE_INVALID", "Stored idempotency result is invalid.");
        const { projectionJson: _, auditId, ...metadata } = parsed;
        return {
          ok: true,
          value: { ...metadata, value: persistedProjection.value },
          auditId,
        };
      } catch {
        return error("IDEMPOTENCY_STORAGE_INVALID", "Stored idempotency result is invalid.");
      }
    }
    try {
      return inImmediateTransaction(database, () => {
        const latestScope = scopeSnapshot(event.projectId, event.connectorId);
        if (
          !latestScope ||
          latestScope.revision !== scope.revision ||
          latestScope.epoch !== scope.epoch ||
          latestScope.review_state !== "READY"
        ) {
          return error("CONNECTOR_AUTHORITY_STALE", "Connector authority changed.", "REFRESH");
        }
        const latest = database
          .query<ProjectionRow, [string, string, string]>(
            `SELECT source_revision, comparable_digest, projection_revision
             FROM connector_projections WHERE project_id = ? AND connector_id = ? AND reference = ?`,
          )
          .get(event.projectId, event.connectorId, event.reference);
        if ((latest?.projection_revision ?? 0) !== (current?.projection_revision ?? 0))
          return error("SOURCE_PROJECTION_STALE", "Source projection changed.", "REFRESH");
        const nextRevision = (latest?.projection_revision ?? 0) + 1;
        const observed: Observed<P> = {
          value: event.value,
          reference: event.reference,
          sourceRevision: event.sourceRevision,
          comparableDigest: event.comparableDigest,
          projectionRevision: nextRevision,
          observedAt: event.observedAt,
          ...(event.sourceUpdatedAt === undefined
            ? {}
            : { sourceUpdatedAt: event.sourceUpdatedAt }),
          freshness: event.freshness,
          provenance: {
            projectId: event.projectId,
            connectorId: event.connectorId,
            connectorEpoch: event.connectorEpoch,
            kind: event.provenance.kind,
            ...(event.provenance.providerActorId === undefined
              ? {}
              : { providerActorId: event.provenance.providerActorId }),
          },
        };
        if (!observedIsBounded(observed))
          return error("RECONCILIATION_INPUT_INVALID", "Reconciliation input is invalid.");
        const auditId = dependencies.id("audit");
        database
          .query(
            `INSERT INTO connector_projections(
               project_id, connector_id, reference, connector_epoch, source_revision,
               comparable_digest, projection_revision, observed_at, source_updated_at,
               freshness, provenance_kind, provider_actor_id, projection_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id, connector_id, reference) DO UPDATE SET
               connector_epoch = excluded.connector_epoch,
               source_revision = excluded.source_revision,
               comparable_digest = excluded.comparable_digest,
               projection_revision = excluded.projection_revision,
               observed_at = excluded.observed_at,
               source_updated_at = excluded.source_updated_at,
               freshness = excluded.freshness,
               provenance_kind = excluded.provenance_kind,
               provider_actor_id = excluded.provider_actor_id,
               projection_json = excluded.projection_json`,
          )
          .run(
            event.projectId,
            event.connectorId,
            event.reference,
            event.connectorEpoch,
            event.sourceRevision,
            event.comparableDigest,
            nextRevision,
            event.observedAt,
            event.sourceUpdatedAt ?? null,
            event.freshness,
            event.provenance.kind,
            event.provenance.providerActorId ?? null,
            encodedProjection.value,
          );
        database
          .query(
            `INSERT INTO source_reconciliation_idempotency(
               project_id, connector_id, connector_epoch, idempotency_key,
               input_hash, result_revision, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.projectId,
            event.connectorId,
            event.connectorEpoch,
            event.idempotencyKey,
            inputHash,
            nextRevision,
            clock(),
          );
        database
          .query(
            "INSERT INTO connector_idempotency(actor_id, idempotency_key, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            reconciliationActorId,
            event.idempotencyKey,
            inputHash,
            JSON.stringify({
              ...observed,
              value: undefined,
              projectionJson: encodedProjection.value,
              auditId,
            }),
            clock(),
          );
        database
          .query(
            "INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at) VALUES (?, 'SOURCE_RECONCILED', 'SYSTEM', 'RECONCILER', ?, ?, ?)",
          )
          .run(
            auditId,
            event.connectorId,
            JSON.stringify({ disposition: "APPLIED", provenance: event.provenance.kind }),
            clock(),
          );
        return { ok: true, value: observed, auditId };
      });
    } catch {
      return error("RECONCILIATION_FAILED", "Source reconciliation failed.");
    }
  };

  return {
    async changeEpoch(
      input: Readonly<{
        actor: MemberActor;
        idempotencyKey: string;
        connectorId: string;
        expectedEpoch: number;
        expectedRevision: number;
        reviewState: "READY" | "REVIEW_REQUIRED" | "REVOKED";
      }>,
    ): Promise<
      Result<
        Readonly<{
          connectorId: string;
          epoch: number;
          reviewState: "READY" | "REVIEW_REQUIRED" | "REVOKED";
          revision: number;
        }>
      >
    > {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.idempotencyKey) ||
        !validBounded(input.connectorId, 128) ||
        !Number.isInteger(input.expectedEpoch) ||
        input.expectedEpoch < 1 ||
        !Number.isInteger(input.expectedRevision) ||
        input.expectedRevision < 1
      )
        return error("CONNECTOR_INPUT_INVALID", "Connector input is invalid.");
      const authority = await browserSessions.authorize(input.actor, { role: "OWNER" });
      if (!authority.ok) return error("OWNER_REQUIRED", "Owner authorization is required.");
      const hash = canonicalInputHash({
        connectorId: input.connectorId,
        expectedEpoch: input.expectedEpoch,
        expectedRevision: input.expectedRevision,
        reviewState: input.reviewState,
      });
      if (!hash) return error("CONNECTOR_INPUT_INVALID", "Connector input is invalid.");
      const storageKey = `EPOCH:${input.idempotencyKey}`;
      const stored = database
        .query<{ input_hash: string; result_json: string }, [string, string]>(
          "SELECT input_hash, result_json FROM connector_idempotency WHERE actor_id = ? AND idempotency_key = ?",
        )
        .get(input.actor.memberId, storageKey);
      if (stored) {
        if (stored.input_hash !== hash)
          return error("IDEMPOTENCY_CONFLICT", "Idempotency key was used with different input.");
        try {
          const parsed = JSON.parse(stored.result_json) as {
            value: {
              connectorId: string;
              epoch: number;
              reviewState: "READY" | "REVIEW_REQUIRED" | "REVOKED";
              revision: number;
            };
            auditId: string;
          };
          return { ok: true, value: parsed.value, auditId: parsed.auditId };
        } catch {
          return error("IDEMPOTENCY_STORAGE_INVALID", "Stored idempotency result is invalid.");
        }
      }
      try {
        return inImmediateTransaction(database, () => {
          if (!browserSessions.revalidate(authority.value, { role: "OWNER" }).ok)
            return error("CONNECTOR_AUTHORITY_STALE", "Connector authority changed.", "REFRESH");
          const changed = database
            .query(
              `UPDATE connector_epochs SET epoch = epoch + 1, review_state = ?,
                 revision = revision + 1
               WHERE connector_id = ? AND epoch = ? AND revision = ?`,
            )
            .run(input.reviewState, input.connectorId, input.expectedEpoch, input.expectedRevision);
          if (changed.changes !== 1)
            return error("CONNECTOR_EPOCH_STALE", "Connector epoch is stale.", "REFRESH");
          const value = {
            connectorId: input.connectorId,
            epoch: input.expectedEpoch + 1,
            reviewState: input.reviewState,
            revision: input.expectedRevision + 1,
          } as const;
          const auditId = dependencies.id("audit");
          database
            .query(
              "INSERT INTO connector_idempotency(actor_id, idempotency_key, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
              input.actor.memberId,
              storageKey,
              hash,
              JSON.stringify({ value, auditId }),
              clock(),
            );
          database
            .query(
              "INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at) VALUES (?, 'CONNECTOR_EPOCH_CHANGED', 'MEMBER', ?, ?, ?, ?)",
            )
            .run(
              auditId,
              input.actor.memberId,
              input.connectorId,
              JSON.stringify({
                previousEpoch: input.expectedEpoch,
                epoch: value.epoch,
                reviewState: input.reviewState,
              }),
              clock(),
            );
          return { ok: true, value, auditId };
        });
      } catch {
        return error("CONNECTOR_OPERATION_FAILED", "Connector operation failed.");
      }
    },

    async mutateAsMember<R, P, M>(
      connector: SourceConnector<R, P, M>,
      input: MemberMutationInput<M>,
    ): Promise<Result<Observed<P>>> {
      const active = await browserSessions.authorize(input.actor);
      if (!active.ok) return active;
      return mutate(connector, "MEMBER", input.actor.memberId, input, {
        browser: active.value,
      });
    },

    async mutateAsAttempt<R, P, M>(
      connector: SourceConnector<R, P, M>,
      input: AttemptMutationInput<M>,
    ): Promise<Result<Observed<P>>> {
      if (!validBounded(input.authorizationProof, 512) || input.authorizationProof.length < 32)
        return error("OPERATION_AUTHORIZATION_INVALID", "Operation authorization is invalid.");
      const authorizationInput = {
        authorizationId: input.authorizationId,
        authorizationProof: input.authorizationProof,
        projectId: input.command.projectId,
        connectorId: input.command.connectorId,
        connectorEpoch: input.command.connectorEpoch,
        reference: input.reference,
        operation: input.operation,
        actionDigest: input.command.actionDigest,
      };
      const verified = await dependencies.attemptAuthority.verify(authorizationInput);
      if (!verified.ok) return verified;
      return mutate(connector, "ATTEMPT", verified.value.actorId, input, {
        consumeAttempt: () => dependencies.attemptAuthority.consume(authorizationInput),
      });
    },

    reconcileSource<P>(event: ReconciliationEvent<P>): Result<Observed<P>> {
      return applyReconciliation(event);
    },

    async recoverPending<R, P, M>(
      connector: SourceConnector<R, P, M>,
      input: Readonly<{ intentId: string }>,
    ): Promise<Result<Observed<P>>> {
      const intent = database
        .query<
          Readonly<{
            id: string;
            actor_id: string;
            idempotency_key: string;
            input_hash: string;
            action_marker: string;
            project_id: string;
            connector_id: string;
            connector_epoch: number;
            scope_revision: number;
            reference: string;
            operation: string;
            precondition_kind: "ABSENT" | "EXACT_REVISION" | "EXPECTED_MEMBERSHIP";
            source_revision: string | null;
            comparable_digest: string | null;
            member_key: string | null;
            expected_present: number | null;
            action_digest: string;
            state: string;
          }>,
          [string]
        >(
          `SELECT id, actor_id, idempotency_key, input_hash, action_marker, project_id,
                  connector_id, connector_epoch, scope_revision, reference, operation,
                  precondition_kind, source_revision, comparable_digest, member_key,
                  expected_present, action_digest, state
           FROM connector_operation_intents WHERE id = ?`,
        )
        .get(input.intentId);
      if (intent?.state !== "PENDING")
        return error("CONNECTOR_INTENT_NOT_RECOVERABLE", "Connector intent is not recoverable.");
      const scopeRow = scopeSnapshot(intent.project_id, intent.connector_id);
      if (
        scopeRow?.review_state !== "READY" ||
        scopeRow.epoch !== intent.connector_epoch ||
        scopeRow.revision !== intent.scope_revision
      ) {
        inImmediateTransaction(database, () => {
          database
            .query(
              "UPDATE connector_operation_intents SET state = 'REQUIRES_REAUTHORIZATION', updated_at = ? WHERE id = ? AND state = 'PENDING'",
            )
            .run(clock(), intent.id);
        });
        return error(
          "CONNECTOR_REAUTHORIZATION_REQUIRED",
          "Connector operation requires reauthorization.",
          "REFRESH",
        );
      }
      const matches: ReconciliationEvent<P>[] = [];
      const expectedPrecondition =
        intent.precondition_kind === "ABSENT"
          ? { kind: "ABSENT" as const }
          : intent.precondition_kind === "EXACT_REVISION"
            ? {
                kind: "EXACT_REVISION" as const,
                sourceRevision: intent.source_revision,
                comparableDigest: intent.comparable_digest,
              }
            : {
                kind: "EXPECTED_MEMBERSHIP" as const,
                sourceRevision: intent.source_revision,
                comparableDigest: intent.comparable_digest,
                memberKey: intent.member_key,
                present: intent.expected_present === 1,
              };
      try {
        for await (const candidate of connector.scan(scopeFrom(scopeRow))) {
          if (!candidate.ok) continue;
          const proof = candidate.value.mutationProof;
          if (
            candidate.value.projectId === intent.project_id &&
            candidate.value.connectorId === intent.connector_id &&
            candidate.value.connectorEpoch === intent.connector_epoch &&
            candidate.value.reference === intent.reference &&
            candidate.value.provenance.kind === "MUTATION_CONFIRMATION" &&
            proof?.actionMarker === intent.action_marker &&
            proof.operation === intent.operation &&
            proof.actionDigest === intent.action_digest &&
            JSON.stringify(proof.precondition) === JSON.stringify(expectedPrecondition)
          ) {
            matches.push(candidate.value);
            if (matches.length > 1) break;
          }
        }
      } catch {
        return error("CONNECTOR_RECOVERY_FAILED", "Connector recovery failed.", "REFRESH");
      }
      if (matches.length === 0)
        return error(
          "CONNECTOR_OPERATION_PENDING",
          "Connector operation outcome is pending reconciliation.",
          "REFRESH",
        );
      if (matches.length > 1) {
        inImmediateTransaction(database, () => {
          database
            .query(
              "UPDATE connector_operation_intents SET state = 'FAILED_PERMANENT', updated_at = ? WHERE id = ? AND state = 'PENDING'",
            )
            .run(clock(), intent.id);
        });
        return error("CONNECTOR_RECOVERY_AMBIGUOUS", "Connector recovery marker is ambiguous.");
      }
      const match = matches[0] as ReconciliationEvent<P>;
      const recoveryProjection = (
        dependencies.projectionCodec(intent.connector_id) as ProjectionCodec<P>
      ).serialize(match.value);
      if (!recoveryProjection.ok)
        return error("CONNECTOR_RECOVERY_FAILED", "Connector recovery failed.");
      try {
        return inImmediateTransaction(database, () => {
          const currentScope = scopeSnapshot(intent.project_id, intent.connector_id);
          const currentIntent = database
            .query<{ state: string }, [string]>(
              "SELECT state FROM connector_operation_intents WHERE id = ?",
            )
            .get(intent.id);
          if (
            currentScope?.review_state !== "READY" ||
            currentScope.epoch !== intent.connector_epoch ||
            currentScope.revision !== intent.scope_revision ||
            currentIntent?.state !== "PENDING"
          ) {
            return error(
              "CONNECTOR_REAUTHORIZATION_REQUIRED",
              "Connector operation requires reauthorization.",
              "REFRESH",
            );
          }
          const currentProjection = database
            .query<ProjectionRow, [string, string, string]>(
              `SELECT source_revision, comparable_digest, projection_revision
               FROM connector_projections
               WHERE project_id = ? AND connector_id = ? AND reference = ?`,
            )
            .get(intent.project_id, intent.connector_id, match.reference);
          const observed: Observed<P> = {
            value: match.value,
            reference: match.reference,
            sourceRevision: match.sourceRevision,
            comparableDigest: match.comparableDigest,
            projectionRevision: (currentProjection?.projection_revision ?? 0) + 1,
            observedAt: match.observedAt,
            ...(match.sourceUpdatedAt === undefined
              ? {}
              : { sourceUpdatedAt: match.sourceUpdatedAt }),
            freshness: match.freshness,
            provenance: {
              projectId: intent.project_id as never,
              connectorId: intent.connector_id as never,
              connectorEpoch: intent.connector_epoch,
              kind: "MUTATION_CONFIRMATION",
              ...(match.provenance.providerActorId === undefined
                ? {}
                : { providerActorId: match.provenance.providerActorId }),
            },
          };
          const auditId = dependencies.id("audit");
          database
            .query(
              `INSERT INTO connector_projections(
                 project_id, connector_id, reference, connector_epoch, source_revision,
                 comparable_digest, projection_revision, observed_at, source_updated_at,
                 freshness, provenance_kind, provider_actor_id, projection_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(project_id, connector_id, reference) DO UPDATE SET
                 connector_epoch = excluded.connector_epoch,
                 source_revision = excluded.source_revision,
                 comparable_digest = excluded.comparable_digest,
                 projection_revision = excluded.projection_revision,
                 observed_at = excluded.observed_at,
                 source_updated_at = excluded.source_updated_at,
                 freshness = excluded.freshness,
                 provenance_kind = excluded.provenance_kind,
                 provider_actor_id = excluded.provider_actor_id,
                 projection_json = excluded.projection_json`,
            )
            .run(
              intent.project_id,
              intent.connector_id,
              observed.reference,
              intent.connector_epoch,
              observed.sourceRevision,
              observed.comparableDigest,
              observed.projectionRevision,
              observed.observedAt,
              observed.sourceUpdatedAt ?? null,
              observed.freshness,
              observed.provenance.kind,
              observed.provenance.providerActorId ?? null,
              recoveryProjection.value,
            );
          database
            .query(
              `UPDATE connector_operation_intents SET state = 'COMMITTED',
                 provider_reference = ?, provider_source_revision = ?,
                 provider_comparable_digest = ?, provenance_kind = ?, provider_actor_id = ?,
                 updated_at = ? WHERE id = ? AND state = 'PENDING'`,
            )
            .run(
              observed.reference,
              observed.sourceRevision,
              observed.comparableDigest,
              observed.provenance.kind,
              observed.provenance.providerActorId ?? null,
              clock(),
              intent.id,
            );
          database
            .query(
              "INSERT INTO connector_idempotency(actor_id, idempotency_key, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
              intent.actor_id,
              intent.idempotency_key,
              intent.input_hash,
              JSON.stringify({
                ...observed,
                value: undefined,
                projectionJson: recoveryProjection.value,
                auditId,
              }),
              clock(),
            );
          database
            .query(
              "INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at) VALUES (?, 'CONNECTOR_MUTATION_RECOVERED', 'SYSTEM', 'RECONCILER', ?, ?, ?)",
            )
            .run(
              auditId,
              intent.connector_id,
              JSON.stringify({ disposition: "CONFIRMED", operationRecovery: true }),
              clock(),
            );
          return { ok: true, value: observed, auditId };
        });
      } catch {
        return error("CONNECTOR_RECOVERY_FAILED", "Connector recovery failed.");
      }
    },
  };
}
