import type { Database } from "bun:sqlite";
import type { AuthenticatedActor } from "../../../shared/contracts/actors.ts";
import {
  type ApplyRevocation,
  type AuthorityPreviewRequest,
  AuthorityPreviewRequestSchema,
  type CollabCommand,
  CollabCommandSchema,
  type CommandResult,
  CommandResultSchema,
  type CoordinationQuery,
  CoordinationQuerySchema,
  type QueryResult,
  type SensitiveOperation,
} from "../../../shared/contracts/commands.ts";
import type { ExecutionAuthority } from "../../../shared/contracts/execution-authority.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type {
  AttemptView,
  CoordinationRecordView,
  EvidenceRecord,
  RunView,
} from "../../../shared/contracts/runs.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import { linkSourceReferences } from "../coordination-records/source-links.ts";
import { createCheckpoint } from "../runs/checkpoints.ts";
import { createEvidence } from "../runs/evidence.ts";
import { transitionAttempt, transitionRun } from "../runs/lifecycle.ts";
import { evaluateRunResult } from "../runs/results.ts";
import type { LaunchAuthorityFacts } from "./contract.ts";
import { readSession, requireSessionFence, sessionView } from "./fencing.ts";
import { createLaunchPersistence } from "./persistence.ts";
import {
  actorMayExecute,
  error,
  inspectOnlyMayAuthorize,
  operationConnector,
  operationNeedsMutationLease,
  requireActivePrincipal,
  safeActor,
} from "./policy.ts";
import { latestRevocationEpoch, revocationSource } from "./revocation.ts";

export type DispatchPermitClaims = Readonly<{
  kind: "DISPATCH_PERMIT";
  attemptId: string;
  snapshotDigest: string;
  issuedAt: number;
  expiresAt: number;
}>;

export type RefreshedAuthorityFacts = LaunchAuthorityFacts &
  Readonly<{
    currentHead?: string;
    connectorScopes?: Readonly<Record<string, readonly string[]>>;
    approvalSubjects?: Readonly<Record<string, string>>;
  }>;

export interface AuthorityFactPort {
  preview(
    request: AuthorityPreviewRequest,
  ): Promise<Result<Readonly<{ refreshedAt: number; profileFingerprint: string }>>>;
  refresh(command: CollabCommand): Promise<Result<RefreshedAuthorityFacts>>;
}

export interface PermitCodec {
  sign(claims: DispatchPermitClaims): Promise<string>;
  verify(token: string): Promise<Result<DispatchPermitClaims>>;
}

export interface RunnerControlPort {
  dispatch(
    intent: Readonly<{
      outboxId: string;
      attemptId: string;
      runnerId: string;
      runnerEpoch: number;
      permit: string;
    }>,
  ): Promise<Result<void>>;
}

export type AuthorityDependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
  authorityFacts: AuthorityFactPort;
  permitCodec: PermitCodec;
  runnerControl: RunnerControlPort;
}>;

type StoredIdempotency = Readonly<{ input_hash: string; result_json: string }>;

function digestHex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function actorId(actor: AuthenticatedActor): string {
  return safeActor(actor).id;
}

function canonicalCommand(command: CollabCommand): string {
  const copy = { ...command, actor: safeActor(command.actor) } as Record<string, unknown>;
  if (command.kind === "CONSUME_PERMIT") {
    copy.permit = digestHex(command.permit);
  }
  return JSON.stringify(copy);
}

function storedResult(
  database: Database,
  command: CollabCommand,
  inputHash: string,
): Result<CommandResult> | undefined {
  const row = database
    .query<StoredIdempotency, [string, string]>(
      "SELECT input_hash, result_json FROM idempotency_results WHERE actor_id = ? AND idempotency_key = ?",
    )
    .get(actorId(command.actor), `${command.kind}:${command.idempotencyKey}`);
  if (!row) return undefined;
  if (row.input_hash !== inputHash) {
    return error("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different input.");
  }
  try {
    const parsed = CommandResultSchema.safeParse(JSON.parse(row.result_json));
    return parsed.success
      ? { ok: true, value: parsed.data as CommandResult }
      : error("IDEMPOTENCY_STORAGE_INVALID", "Stored idempotency result is invalid.");
  } catch {
    return error("IDEMPOTENCY_STORAGE_INVALID", "Stored idempotency result is invalid.");
  }
}

function persistIdempotency(
  database: Database,
  command: CollabCommand,
  inputHash: string,
  result: CommandResult,
  now: number,
): void {
  database
    .query(
      `INSERT INTO idempotency_results(actor_id, idempotency_key, input_hash, result_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      actorId(command.actor),
      `${command.kind}:${command.idempotencyKey}`,
      inputHash,
      JSON.stringify(result),
      now,
    );
}

function audit(
  dependencies: AuthorityDependencies,
  command: CollabCommand,
  subjectId: string | null,
  safeDetails: Readonly<Record<string, string | number | boolean>>,
): void {
  const actor = safeActor(command.actor);
  dependencies.database
    .query(
      `INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      dependencies.id("audit"),
      command.kind,
      actor.kind,
      actor.id,
      subjectId,
      JSON.stringify(safeDetails),
      dependencies.clock(),
    );
}

function attemptView(database: Database, attemptId: string): AttemptView | undefined {
  const row = database
    .query<
      {
        id: string;
        run_id: string;
        runner_id: string;
        state: AttemptView["state"];
        revision: number;
      },
      [string]
    >("SELECT id, run_id, runner_id, state, revision FROM execution_attempts WHERE id = ?")
    .get(attemptId);
  return row
    ? {
        id: row.id as never,
        runId: row.run_id as never,
        runnerId: row.runner_id as never,
        state: row.state,
        revision: row.revision,
      }
    : undefined;
}

function runView(database: Database, runId: string): RunView | undefined {
  const row = database
    .query<
      {
        id: string;
        coordination_record_id: string;
        state: RunView["state"];
        goal: string;
        repository_mode: RunView["repositoryMode"];
        repository_assurance: RunView["repositoryAssurance"];
        revision: number;
      },
      [string]
    >(
      `SELECT id, coordination_record_id, state, goal, repository_mode,
              repository_assurance, revision FROM agent_runs WHERE id = ?`,
    )
    .get(runId);
  if (!row) return undefined;
  const attemptIds = database
    .query<{ id: string }, [string]>(
      "SELECT id FROM execution_attempts WHERE run_id = ? ORDER BY ordinal",
    )
    .all(runId)
    .map((attempt) => attempt.id as never);
  return {
    id: row.id as never,
    coordinationRecordId: row.coordination_record_id as never,
    state: row.state,
    goal: row.goal,
    repositoryMode: row.repository_mode,
    repositoryAssurance: row.repository_assurance,
    revision: row.revision,
    attemptIds,
  };
}

function recordView(database: Database, recordId: string): CoordinationRecordView | undefined {
  const row = database
    .query<{ id: string; project_id: string; title: string; revision: number }, [string]>(
      "SELECT id, project_id, title, revision FROM coordination_records WHERE id = ?",
    )
    .get(recordId);
  if (!row) return undefined;
  return {
    id: row.id as never,
    projectId: row.project_id as never,
    title: row.title,
    revision: row.revision,
    runIds: database
      .query<{ id: string }, [string]>(
        "SELECT id FROM agent_runs WHERE coordination_record_id = ? ORDER BY created_at, id",
      )
      .all(recordId)
      .map((run) => run.id as never),
  };
}

async function dispatchCommitted(
  dependencies: AuthorityDependencies,
  outboxIds: readonly string[],
): Promise<void> {
  for (const outboxId of outboxIds) {
    const row = dependencies.database
      .query<
        {
          attempt_id: string;
          runner_id: string;
          runner_epoch: number;
          snapshot_digest: string;
          issued_at: number;
          expires_at: number;
        },
        [string]
      >(
        `SELECT o.attempt_id, o.runner_id, o.runner_epoch, s.snapshot_digest,
                p.issued_at, p.expires_at
         FROM runner_dispatch_outbox o
         JOIN authority_snapshots s ON s.id = o.authority_snapshot_id
         JOIN dispatch_permits p ON p.id = o.permit_id
         WHERE o.id = ? AND o.status = 'PENDING'`,
      )
      .get(outboxId);
    if (!row) continue;
    const claims: DispatchPermitClaims = {
      kind: "DISPATCH_PERMIT",
      attemptId: row.attempt_id,
      snapshotDigest: row.snapshot_digest,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    };
    const permit = await dependencies.permitCodec.sign(claims);
    const sent = await dependencies.runnerControl.dispatch({
      outboxId,
      attemptId: row.attempt_id,
      runnerId: row.runner_id,
      runnerEpoch: row.runner_epoch,
      permit,
    });
    if (sent.ok) {
      dependencies.database
        .query(
          `UPDATE runner_dispatch_outbox
           SET status = 'DISPATCHED', dispatched_at = ?
           WHERE id = ? AND status = 'PENDING'`,
        )
        .run(dependencies.clock(), outboxId);
    }
  }
}

function nextSequence(database: Database, table: string, column: string, id: string): number {
  const row = database
    .query<{ sequence: number }, [string]>(
      `SELECT coalesce(max(sequence), 0) + 1 AS sequence FROM ${table} WHERE ${column} = ?`,
    )
    .get(id);
  return row?.sequence ?? 1;
}

function releaseGuardIfNoActiveParticipants(database: Database, runId: string, now: number): void {
  const guards = database
    .query<{ id: string }, [string, string]>(
      `SELECT DISTINCT g.id FROM work_item_mutation_guards g
       LEFT JOIN mutation_guard_overrides o ON o.mutation_guard_id = g.id
       WHERE g.state = 'HELD' AND (g.run_id = ? OR o.colliding_run_id = ?)`,
    )
    .all(runId, runId);
  for (const guard of guards) {
    const active =
      database
        .query<{ count: number }, [string, string]>(
          `SELECT count(*) AS count FROM (
           SELECT r.id FROM work_item_mutation_guards g
           JOIN agent_runs r ON r.id = g.run_id
           WHERE g.id = ? AND r.state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
           UNION ALL
           SELECT r.id FROM mutation_guard_overrides o
           JOIN agent_runs r ON r.id = o.colliding_run_id
           WHERE o.mutation_guard_id = ? AND r.state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
         )`,
        )
        .get(guard.id, guard.id)?.count ?? 0;
    if (active === 0) {
      database
        .query(
          `UPDATE work_item_mutation_guards SET state = 'RELEASED', released_at = ?, revision = revision + 1
           WHERE id = ? AND state = 'HELD'`,
        )
        .run(now, guard.id);
    }
  }
}

function finalizeRunIfReady(
  dependencies: AuthorityDependencies,
  runId: string,
  actor: Readonly<{ kind: "MEMBER" | "SCHEDULER" | "RUNNER"; id: string }>,
  now: number,
): void {
  const run = dependencies.database
    .query<
      {
        state: RunView["state"];
        maximum_attempts: number;
        deadline_at: number;
        attempt_count: number;
      },
      [string]
    >(
      `SELECT r.state, p.maximum_attempts, p.deadline_at,
              (SELECT count(*) FROM execution_attempts a WHERE a.run_id = r.id) AS attempt_count
       FROM agent_runs r JOIN run_execution_policies p ON p.run_id = r.id WHERE r.id = ?`,
    )
    .get(runId);
  if (!run || ["COMPLETED", "FAILED", "CANCELLED"].includes(run.state)) return;
  const attempt = dependencies.database
    .query<{ id: string; state: string; terminal_at: number | null }, [string]>(
      `SELECT id, state, terminal_at FROM execution_attempts
       WHERE run_id = ? ORDER BY ordinal DESC LIMIT 1`,
    )
    .get(runId);
  if (!attempt) return;
  const result = dependencies.database
    .query<{ result_kind: string }, [string]>(
      "SELECT result_kind FROM run_results WHERE attempt_id = ?",
    )
    .get(attempt.id);
  const requiredGates =
    dependencies.database
      .query<{ count: number }, [string]>(
        `SELECT count(*) AS count FROM run_configuration_snapshots s
       JOIN personal_run_preset_gates g
         ON g.preset_id = s.preset_id AND g.preset_version = s.preset_version
       WHERE s.run_id = ? AND g.required = 1`,
      )
      .get(runId)?.count ?? 0;
  const passedGates =
    dependencies.database
      .query<{ count: number }, [string, string, string, string, string]>(
        `WITH current_head(head) AS (
         SELECT coalesce(
           (SELECT secondary_revision FROM run_evidence
            WHERE run_id = ? AND evidence_kind = 'DIFF_STATS'
            ORDER BY created_at DESC, id DESC LIMIT 1),
           (SELECT repository_revision FROM run_evidence
            WHERE run_id = ? AND evidence_kind = 'PUBLISHED_GIT_REFERENCE'
            ORDER BY created_at DESC, id DESC LIMIT 1),
           (SELECT base_commit FROM agent_runs WHERE id = ?)
         )
       ), latest_gate(gate_key, manifest_fingerprint, evidence_revision) AS (
         SELECT e.gate_key, e.manifest_fingerprint, max(e.evidence_revision)
         FROM run_evidence e, current_head h
         WHERE e.run_id = ? AND e.evidence_kind = 'GATE_EVALUATION'
           AND e.repository_revision = h.head
         GROUP BY e.gate_key, e.manifest_fingerprint
       )
       SELECT count(*) AS count FROM run_configuration_snapshots s
       JOIN personal_run_preset_gates g
         ON g.preset_id = s.preset_id AND g.preset_version = s.preset_version
        AND g.required = 1
       JOIN latest_gate l
         ON l.gate_key = g.gate_name AND l.manifest_fingerprint = g.manifest_fingerprint
       JOIN run_evidence e
         ON e.run_id = s.run_id AND e.evidence_kind = 'GATE_EVALUATION'
        AND e.gate_key = l.gate_key AND e.manifest_fingerprint = l.manifest_fingerprint
        AND e.evidence_revision = l.evidence_revision
       JOIN current_head h ON e.repository_revision = h.head
       WHERE s.run_id = ? AND e.outcome = 'PASSED'`,
      )
      .get(runId, runId, runId, runId, runId)?.count ?? 0;
  const terminalAt = Math.max(now, attempt.terminal_at ?? now);
  if (
    attempt.state === "EXITED" &&
    (result?.result_kind === "DELIVERED" || result?.result_kind === "NO_CHANGES") &&
    passedGates === requiredGates
  ) {
    dependencies.database
      .query(
        `UPDATE agent_runs SET state = 'COMPLETED', waiting_reason = NULL, terminal_reason = ?,
           started_at = coalesce(started_at, created_at), terminal_at = ?, revision = revision + 1
         WHERE id = ? AND state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
      )
      .run(result.result_kind, terminalAt, runId);
    releaseGuardIfNoActiveParticipants(dependencies.database, runId, terminalAt);
    dependencies.database
      .query(
        `INSERT INTO run_lifecycle_events(
           id, run_id, sequence, event_kind, from_state, to_state, reason_code,
           actor_kind, actor_id, occurred_at
         ) VALUES (?, ?, ?, 'COMPLETED', ?, 'COMPLETED', ?, ?, ?, ?)`,
      )
      .run(
        dependencies.id("run_event"),
        runId,
        nextSequence(dependencies.database, "run_lifecycle_events", "run_id", runId),
        run.state,
        result.result_kind,
        actor.kind,
        actor.id,
        terminalAt,
      );
    return;
  }
  const exhausted = run.attempt_count >= run.maximum_attempts || now >= run.deadline_at;
  if (["FAILED_TO_START", "LOST", "TIMED_OUT"].includes(attempt.state) && exhausted) {
    const reason = now >= run.deadline_at ? "DEADLINE" : "FAILED";
    dependencies.database
      .query(
        `UPDATE agent_runs SET state = 'FAILED', waiting_reason = NULL, terminal_reason = ?,
           started_at = coalesce(started_at, created_at), terminal_at = ?, revision = revision + 1
         WHERE id = ? AND state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
      )
      .run(reason, terminalAt, runId);
    releaseGuardIfNoActiveParticipants(dependencies.database, runId, terminalAt);
    dependencies.database
      .query(
        `INSERT INTO run_lifecycle_events(
           id, run_id, sequence, event_kind, from_state, to_state, reason_code,
           actor_kind, actor_id, occurred_at
         ) VALUES (?, ?, ?, 'FAILED', ?, 'FAILED', ?, ?, ?, ?)`,
      )
      .run(
        dependencies.id("run_event"),
        runId,
        nextSequence(dependencies.database, "run_lifecycle_events", "run_id", runId),
        run.state,
        reason,
        actor.kind,
        actor.id,
        terminalAt,
      );
    return;
  }
  if (attempt.state === "EXITED" && (!result || passedGates !== requiredGates)) {
    dependencies.database
      .query(
        `UPDATE agent_runs SET state = 'WAITING', waiting_reason = 'BLOCKED',
           started_at = coalesce(started_at, created_at), revision = revision + 1
         WHERE id = ? AND state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
      )
      .run(runId);
  }
}

function operationColumns(operation: SensitiveOperation): Readonly<{
  resourceId: string | null;
  expectedRevision: string | null;
  connectorId: string | null;
  connectorEpoch: number | null;
  actionDigest: string | null;
}> {
  switch (operation.kind) {
    case "MUTATE_REPOSITORY":
      return {
        resourceId: "REPOSITORY",
        expectedRevision: operation.expectedHead,
        connectorId: null,
        connectorEpoch: null,
        actionDigest: null,
      };
    case "PUBLISH_GIT_REFERENCE":
      return {
        resourceId: operation.remoteRef,
        expectedRevision: operation.expectedHead,
        connectorId: null,
        connectorEpoch: null,
        actionDigest: null,
      };
    case "MUTATE_GITHUB":
      return {
        resourceId: operation.resourceId,
        expectedRevision:
          operation.precondition.kind === "ABSENT"
            ? "ABSENT"
            : operation.precondition.sourceRevision,
        connectorId: operation.connectorId,
        connectorEpoch: operation.connectorEpoch,
        actionDigest: operation.actionDigest,
      };
    case "MUTATE_OUTLINE":
      return {
        resourceId: operation.documentId,
        expectedRevision:
          operation.precondition.kind === "ABSENT"
            ? "ABSENT"
            : operation.precondition.sourceRevision,
        connectorId: operation.connectorId,
        connectorEpoch: operation.connectorEpoch,
        actionDigest: operation.actionDigest,
      };
    case "APPLY_APPROVAL_TRANSITION":
      return {
        resourceId: operation.approvalSubjectId,
        expectedRevision: operation.expectedSubjectDigest,
        connectorId: null,
        connectorEpoch: null,
        actionDigest: null,
      };
    case "EXECUTE_LOCAL_GATE":
      return {
        resourceId: operation.gateEvaluationId,
        expectedRevision: operation.repositoryRevision,
        connectorId: null,
        connectorEpoch: null,
        actionDigest: operation.manifestFingerprint,
      };
    case "DISCARD_RETAINED_WORK":
      return {
        resourceId: operation.retainedWorkId,
        expectedRevision: null,
        connectorId: null,
        connectorEpoch: null,
        actionDigest: null,
      };
  }
}

async function executeLaunch(
  dependencies: AuthorityDependencies,
  command: Extract<CollabCommand, { kind: "LAUNCH_RUN" }>,
  facts: RefreshedAuthorityFacts,
): Promise<Result<CommandResult>> {
  const principal = requireActivePrincipal(dependencies.database, command.actor);
  if (!principal.ok) return principal;
  if (facts.deadlineAt <= dependencies.clock()) {
    return error("DEADLINE_EXCEEDED", "Agent Run deadline has elapsed.");
  }
  const {
    currentHead: _currentHead,
    connectorScopes: _connectorScopes,
    approvalSubjects: _approvalSubjects,
    ...launchFacts
  } = facts;
  const persistence = createLaunchPersistence({
    database: dependencies.database,
    clock: dependencies.clock,
    id: dependencies.id,
  });
  const committed = await persistence.create({ command, authority: launchFacts });
  if (!committed.ok) return committed;
  await dispatchCommitted(dependencies, committed.value.outboxIds);
  return { ok: true, value: committed.value.result };
}

function currentAttemptFactsMatch(
  database: Database,
  runId: string,
  command: Extract<CollabCommand, { kind: "AUTHORIZE_ATTEMPT" }>,
  facts: RefreshedAuthorityFacts,
): boolean {
  const row = database
    .query<
      {
        project_id: string;
        project_revision: number;
        runner_owner_member_id: string;
        runner_epoch: number;
        policy_revision: number;
        security_policy_version: number;
        security_digest: string;
        revoked_at: number | null;
      },
      [string, string]
    >(
      `SELECT r.project_id, p.revision AS project_revision,
              rr.owner_member_id AS runner_owner_member_id, rr.runner_epoch,
              rr.policy_revision, rr.security_policy_version, rr.security_digest, rr.revoked_at
       FROM agent_runs r
       JOIN projects p ON p.id = r.project_id
       JOIN runners rr ON rr.id = ?
       WHERE r.id = ?`,
    )
    .get(command.execution.runnerId, runId);
  if (
    !row ||
    row.revoked_at !== null ||
    row.project_revision !== facts.projectRevision ||
    row.runner_owner_member_id !== facts.runnerOwnerMemberId ||
    row.runner_epoch !== command.execution.expectedRunnerEpoch ||
    row.policy_revision !== facts.runnerPolicyRevision ||
    row.security_policy_version !== facts.securityPolicyVersion ||
    row.security_digest !== facts.securityDigest
  ) {
    return false;
  }
  const mapping = database
    .query<{ count: number }, [string, string, number]>(
      `SELECT count(*) AS count FROM runner_mapping_versions
       WHERE runner_id = ? AND project_id = ? AND revision = ? AND revoked_at IS NULL`,
    )
    .get(command.execution.runnerId, row.project_id, command.execution.projectMappingRevision);
  const profile = database
    .query<{ count: number }, [string, string, number, string]>(
      `SELECT count(*) AS count FROM safe_profile_versions
       WHERE runner_id = ? AND profile_id = ? AND version = ? AND fingerprint = ?`,
    )
    .get(
      command.execution.runnerId,
      command.execution.profileVersionId,
      command.execution.expectedProfileVersion,
      facts.profileFingerprint,
    );
  if (
    mapping?.count !== 1 ||
    profile?.count !== 1 ||
    facts.profileVersion !== command.execution.expectedProfileVersion
  )
    return false;
  if (facts.authorizationSource === "OWNER") {
    return command.execution.exposureRevision === undefined;
  }
  if (command.execution.exposureRevision === undefined) return false;
  return (
    database
      .query<{ count: number }, [string, string, number, string, number, number]>(
        `SELECT count(*) AS count FROM runner_exposures
         WHERE runner_id = ? AND project_id = ? AND mapping_revision = ?
           AND profile_id = ? AND profile_version = ? AND revision = ? AND revoked_at IS NULL`,
      )
      .get(
        command.execution.runnerId,
        row.project_id,
        command.execution.projectMappingRevision,
        command.execution.profileVersionId,
        facts.profileVersion,
        command.execution.exposureRevision,
      )?.count === 1
  );
}

function waitingAttemptDecision(run: RunView, code: string): CommandResult {
  return {
    kind: "AUTHORIZE_ATTEMPT",
    decision: { outcome: "WAITING", run, code, retry: "EXPLICIT_RESUME" },
  };
}

async function executeAuthorizeAttempt(
  dependencies: AuthorityDependencies,
  command: Extract<CollabCommand, { kind: "AUTHORIZE_ATTEMPT" }>,
  facts: RefreshedAuthorityFacts,
  inputHash: string,
): Promise<Result<CommandResult>> {
  const now = dependencies.clock();
  const ids = {
    attempt: dependencies.id("attempt"),
    snapshot: dependencies.id("snapshot"),
    permit: dependencies.id("permit"),
    outbox: dependencies.id("outbox"),
  };
  const snapshotDigest = digestHex(
    JSON.stringify({
      command: canonicalCommand(command),
      facts,
      attemptId: ids.attempt,
      createdAt: now,
    }),
  );
  const claims: DispatchPermitClaims = {
    kind: "DISPATCH_PERMIT",
    attemptId: ids.attempt,
    snapshotDigest,
    issuedAt: now,
    expiresAt: now + facts.permitSeconds,
  };
  const claimsHash = digestHex(JSON.stringify(claims));
  const semanticDigest = digestHex(
    JSON.stringify({
      kind: "LAUNCH_ATTEMPT",
      attemptId: ids.attempt,
      runnerId: command.execution.runnerId,
      runnerEpoch: command.execution.expectedRunnerEpoch,
      snapshotId: ids.snapshot,
      permitId: ids.permit,
    }),
  );
  const result = inImmediateTransaction<Result<CommandResult>>(dependencies.database, () => {
    const replay = storedResult(dependencies.database, command, inputHash);
    if (replay) return replay;
    const principal = requireActivePrincipal(dependencies.database, command.actor);
    if (!principal.ok) return principal;
    const runRow = dependencies.database
      .query<
        {
          id: string;
          coordination_record_id: string;
          project_id: string;
          state: RunView["state"];
          revision: number;
          dispatcher_id: string;
          repository_id: string;
          repository_mode: "MUTATING" | "INSPECT_ONLY";
          repository_assurance: "ADVISORY" | "ENFORCED";
          base_commit: string;
          base_branch: string;
          intended_branch: string | null;
          effective_configuration_id: string;
          effective_configuration_version: number;
          effective_configuration_digest: string;
          maximum_attempts: number;
          deadline_at: number;
        },
        [string]
      >(
        `SELECT r.*, p.maximum_attempts, p.deadline_at
         FROM agent_runs r JOIN run_execution_policies p ON p.run_id = r.id
         WHERE r.id = ?`,
      )
      .get(command.runId);
    if (!runRow) return error("RUN_NOT_FOUND", "Agent Run was not found.");
    const currentRun = runView(dependencies.database, command.runId);
    if (!currentRun) return error("RUN_NOT_FOUND", "Agent Run was not found.");
    if (runRow.revision !== command.expectedRunRevision) {
      return error("RUN_REVISION_STALE", "Agent Run revision is stale.", "REFRESH");
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(runRow.state)) {
      const denied: CommandResult = {
        kind: "AUTHORIZE_ATTEMPT",
        decision: { outcome: "DENIED", code: "RUN_TERMINAL" },
      };
      persistIdempotency(dependencies.database, command, inputHash, denied, now);
      return { ok: true, value: denied };
    }
    if (runRow.dispatcher_id !== principal.value.id) {
      const denied: CommandResult = {
        kind: "AUTHORIZE_ATTEMPT",
        decision: { outcome: "DENIED", code: "DISPATCHER_AUTHORITY_CHANGED" },
      };
      persistIdempotency(dependencies.database, command, inputHash, denied, now);
      return { ok: true, value: denied };
    }
    const attemptCount =
      dependencies.database
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM execution_attempts WHERE run_id = ?",
        )
        .get(command.runId)?.count ?? 0;
    if (attemptCount >= runRow.maximum_attempts) {
      const waiting = waitingAttemptDecision(currentRun, "ATTEMPT_BUDGET_EXHAUSTED");
      persistIdempotency(dependencies.database, command, inputHash, waiting, now);
      return { ok: true, value: waiting };
    }
    if (now >= runRow.deadline_at) {
      const waiting = waitingAttemptDecision(currentRun, "DEADLINE_EXCEEDED");
      persistIdempotency(dependencies.database, command, inputHash, waiting, now);
      return { ok: true, value: waiting };
    }
    const active =
      dependencies.database
        .query<{ count: number }, [string]>(
          `SELECT count(*) AS count FROM execution_attempts
         WHERE run_id = ? AND state IN ('PENDING', 'STARTING', 'RUNNING')`,
        )
        .get(command.runId)?.count ?? 0;
    if (active > 0) {
      const waiting = waitingAttemptDecision(currentRun, "ATTEMPT_ALREADY_ACTIVE");
      persistIdempotency(dependencies.database, command, inputHash, waiting, now);
      return { ok: true, value: waiting };
    }
    if (command.cause.kind === "RESUME") {
      const checkpoint = dependencies.database
        .query<{ count: number }, [string, string]>(
          "SELECT count(*) AS count FROM run_checkpoints WHERE id = ? AND run_id = ?",
        )
        .get(command.cause.checkpointId, command.runId);
      if (checkpoint?.count !== 1) {
        const waiting = waitingAttemptDecision(currentRun, "CHECKPOINT_REQUIRED");
        persistIdempotency(dependencies.database, command, inputHash, waiting, now);
        return { ok: true, value: waiting };
      }
    }
    if (!currentAttemptFactsMatch(dependencies.database, command.runId, command, facts)) {
      const waiting = waitingAttemptDecision(currentRun, "RUNNER_POLICY_STALE");
      persistIdempotency(dependencies.database, command, inputHash, waiting, now);
      return { ok: true, value: waiting };
    }
    const ordinal = attemptCount + 1;
    dependencies.database
      .query(
        `INSERT INTO execution_attempts(
           id, run_id, project_id, ordinal, runner_id, runner_epoch, mapping_revision,
           profile_version_id, profile_version, profile_fingerprint, exposure_revision,
           host, interaction, state, revision, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?)`,
      )
      .run(
        ids.attempt,
        command.runId,
        runRow.project_id,
        ordinal,
        command.execution.runnerId,
        command.execution.expectedRunnerEpoch,
        command.execution.projectMappingRevision,
        command.execution.profileVersionId,
        facts.profileVersion,
        facts.profileFingerprint,
        command.execution.exposureRevision ?? null,
        command.execution.host,
        command.execution.interaction,
        now,
      );
    dependencies.database
      .query(
        `INSERT INTO authority_snapshots(
           id, attempt_id, run_id, project_id, project_revision, actor_kind, actor_id,
           actor_context_id, runner_id, runner_owner_member_id, runner_epoch,
           runner_policy_revision, mapping_revision, profile_version_id, profile_version,
           profile_fingerprint, exposure_revision, authorization_source, security_policy_version,
           security_digest, repository_id, repository_mode, repository_assurance, base_commit,
           base_branch, intended_branch, effective_configuration_id, effective_configuration_version,
           effective_configuration_digest, permit_seconds, authority_session_seconds,
           authority_renewal_seconds, mutation_disconnect_grace_seconds, snapshot_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ids.snapshot,
        ids.attempt,
        command.runId,
        runRow.project_id,
        facts.projectRevision,
        principal.value.kind,
        principal.value.id,
        principal.value.contextId ?? null,
        command.execution.runnerId,
        facts.runnerOwnerMemberId,
        command.execution.expectedRunnerEpoch,
        facts.runnerPolicyRevision,
        command.execution.projectMappingRevision,
        command.execution.profileVersionId,
        facts.profileVersion,
        facts.profileFingerprint,
        command.execution.exposureRevision ?? null,
        facts.authorizationSource,
        facts.securityPolicyVersion,
        facts.securityDigest,
        runRow.repository_id,
        runRow.repository_mode,
        runRow.repository_assurance,
        runRow.base_commit,
        runRow.base_branch,
        runRow.intended_branch,
        runRow.effective_configuration_id,
        runRow.effective_configuration_version,
        runRow.effective_configuration_digest,
        facts.permitSeconds,
        facts.authoritySessionSeconds,
        facts.authorityRenewalSeconds,
        facts.mutationDisconnectGraceSeconds,
        snapshotDigest,
        now,
      );
    dependencies.database
      .query(
        `INSERT INTO dispatch_permits(
           id, attempt_id, authority_snapshot_id, claims_hash, state, revision, issued_at, expires_at
         ) VALUES (?, ?, ?, ?, 'ISSUED', 1, ?, ?)`,
      )
      .run(ids.permit, ids.attempt, ids.snapshot, claimsHash, now, claims.expiresAt);
    dependencies.database
      .query(
        `INSERT INTO runner_dispatch_outbox(
           id, delivery_kind, attempt_id, runner_id, runner_epoch, authority_snapshot_id,
           permit_id, semantic_digest, status, created_at, expires_at
         ) VALUES (?, 'LAUNCH_ATTEMPT', ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      )
      .run(
        ids.outbox,
        ids.attempt,
        command.execution.runnerId,
        command.execution.expectedRunnerEpoch,
        ids.snapshot,
        ids.permit,
        semanticDigest,
        now,
        claims.expiresAt,
      );
    dependencies.database
      .query(
        `UPDATE agent_runs SET state = 'RUNNING', waiting_reason = NULL,
           started_at = coalesce(started_at, ?), revision = revision + 1 WHERE id = ?`,
      )
      .run(now, command.runId);
    dependencies.database
      .query(
        `INSERT INTO run_lifecycle_events(
           id, run_id, sequence, event_kind, from_state, to_state,
           actor_kind, actor_id, occurred_at
         ) VALUES (?, ?, ?, 'ATTEMPT_AUTHORIZED', ?, 'RUNNING', ?, ?, ?)`,
      )
      .run(
        dependencies.id("run_event"),
        command.runId,
        nextSequence(dependencies.database, "run_lifecycle_events", "run_id", command.runId),
        runRow.state,
        principal.value.kind,
        principal.value.id,
        now,
      );
    const run = runView(dependencies.database, command.runId);
    const attempt = attemptView(dependencies.database, ids.attempt);
    if (!run || !attempt)
      return error("AUTHORITY_STORAGE_FAILED", "Authority state is unavailable.");
    const authorized: CommandResult = {
      kind: "AUTHORIZE_ATTEMPT",
      decision: {
        outcome: "AUTHORIZED",
        run,
        attempt,
        dispatch: {
          state: "QUEUED",
          runnerId: command.execution.runnerId,
          attemptId: ids.attempt as never,
          expiresAt: claims.expiresAt as never,
        },
      },
    };
    audit(dependencies, command, command.runId, { cause: command.cause.kind, ordinal });
    persistIdempotency(dependencies.database, command, inputHash, authorized, now);
    return { ok: true, value: authorized };
  });
  if (
    result.ok &&
    result.value.kind === "AUTHORIZE_ATTEMPT" &&
    result.value.decision.outcome === "AUTHORIZED"
  ) {
    await dispatchCommitted(dependencies, [ids.outbox]);
  }
  return result;
}

function executeConsumePermit(
  dependencies: AuthorityDependencies,
  command: Extract<CollabCommand, { kind: "CONSUME_PERMIT" }>,
  claims: DispatchPermitClaims,
  inputHash: string,
): Result<CommandResult> {
  const now = dependencies.clock();
  return inImmediateTransaction(dependencies.database, () => {
    const replay = storedResult(dependencies.database, command, inputHash);
    if (replay) return replay;
    const principal = requireActivePrincipal(dependencies.database, command.actor);
    if (!principal.ok) return principal;
    if (
      command.actor.kind !== "RUNNER" ||
      command.actor.runnerId !== command.runnerId ||
      command.actor.runnerEpoch !== command.runnerEpoch
    ) {
      return error("RUNNER_ACTOR_MISMATCH", "Runner actor does not match the permit audience.");
    }
    const row = dependencies.database
      .query<
        {
          permit_id: string;
          permit_state: string;
          claims_hash: string;
          issued_at: number;
          expires_at: number;
          attempt_id: string;
          snapshot_digest: string;
          run_id: string;
          runner_id: string;
          runner_epoch: number;
          runner_policy_revision: number;
          repository_mode: "MUTATING" | "INSPECT_ONLY";
          repository_assurance: "ADVISORY" | "ENFORCED";
          authority_session_seconds: number;
          mutation_disconnect_grace_seconds: number;
          current_runner_epoch: number;
          current_policy_revision: number;
          runner_revoked_at: number | null;
          deadline_at: number;
        },
        [string]
      >(
        `SELECT p.id AS permit_id, p.state AS permit_state, p.claims_hash, p.issued_at,
                p.expires_at, p.attempt_id, s.snapshot_digest, s.run_id, s.runner_id,
                s.runner_epoch, s.runner_policy_revision, s.repository_mode,
                s.repository_assurance, s.authority_session_seconds,
                s.mutation_disconnect_grace_seconds, r.runner_epoch AS current_runner_epoch,
                r.policy_revision AS current_policy_revision, r.revoked_at AS runner_revoked_at,
                rp.deadline_at
         FROM dispatch_permits p
         JOIN authority_snapshots s ON s.id = p.authority_snapshot_id
         JOIN runners r ON r.id = s.runner_id
         JOIN run_execution_policies rp ON rp.run_id = s.run_id
         WHERE p.attempt_id = ?`,
      )
      .get(claims.attemptId);
    if (!row || row.snapshot_digest !== claims.snapshotDigest) {
      return error("PERMIT_INVALID", "Dispatch Permit is invalid.");
    }
    if (row.claims_hash !== digestHex(JSON.stringify(claims))) {
      return error("PERMIT_INVALID", "Dispatch Permit is invalid.");
    }
    if (row.permit_state === "CONSUMED") {
      return error("PERMIT_REPLAYED", "Dispatch Permit was already consumed.");
    }
    if (row.permit_state === "REVOKED") {
      return error("PERMIT_REVOKED", "Dispatch Permit was revoked.");
    }
    if (row.permit_state === "EXPIRED" || now >= row.expires_at || now >= row.deadline_at) {
      dependencies.database
        .query(
          "UPDATE dispatch_permits SET state = 'EXPIRED', revision = revision + 1 WHERE id = ?",
        )
        .run(row.permit_id);
      return error("PERMIT_EXPIRED", "Dispatch Permit expired.", "EXPLICIT_RESUME");
    }
    if (
      row.runner_id !== command.runnerId ||
      row.runner_epoch !== command.runnerEpoch ||
      row.current_runner_epoch !== command.runnerEpoch ||
      row.current_policy_revision !== row.runner_policy_revision ||
      row.runner_revoked_at !== null
    ) {
      dependencies.database
        .query(
          "UPDATE dispatch_permits SET state = 'REVOKED', revision = revision + 1, revoked_at = ? WHERE id = ?",
        )
        .run(now, row.permit_id);
      return error("PERMIT_REVOKED", "Dispatch Permit authority changed.", "REFRESH");
    }
    const activeRevocation =
      dependencies.database
        .query<{ count: number }, [string, string, string]>(
          `SELECT count(*) AS count FROM authority_revocations
         WHERE (source_kind = 'RUN' AND source_id = ?)
            OR (source_kind = 'RUNNER' AND source_id = ?)
            OR (source_kind = 'MEMBER' AND source_id = ?)`,
        )
        .get(row.run_id, row.runner_id, principal.value.id)?.count ?? 0;
    if (activeRevocation > 0) {
      dependencies.database
        .query(
          "UPDATE dispatch_permits SET state = 'REVOKED', revision = revision + 1, revoked_at = ? WHERE id = ?",
        )
        .run(now, row.permit_id);
      return error("PERMIT_REVOKED", "Dispatch Permit authority was revoked.", "REFRESH");
    }
    const sessionId = dependencies.id("authority_session");
    const connectorEpochs = dependencies.database
      .query<{ connector_id: string; connector_epoch: number }, [string]>(
        "SELECT connector_id, connector_epoch FROM run_execution_connector_epochs WHERE run_id = ?",
      )
      .all(row.run_id);
    const connectorEpochsDigest = digestHex(
      JSON.stringify(
        Object.fromEntries(
          connectorEpochs.map((epoch) => [epoch.connector_id, epoch.connector_epoch]),
        ),
      ),
    );
    const sessionExpiresAt = Math.min(now + row.authority_session_seconds, row.deadline_at);
    dependencies.database
      .query(
        `INSERT INTO authority_sessions(
           id, attempt_id, runner_id, runner_epoch, connection_id, fence, repository_mode,
           repository_assurance, connector_epochs_digest, state, revision, issued_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 'ACTIVE', 1, ?, ?)`,
      )
      .run(
        sessionId,
        row.attempt_id,
        row.runner_id,
        row.runner_epoch,
        command.connectionId,
        row.repository_mode,
        row.repository_assurance,
        connectorEpochsDigest,
        now,
        sessionExpiresAt,
      );
    for (const epoch of connectorEpochs) {
      dependencies.database
        .query(
          `INSERT INTO authority_session_connector_epochs(session_id, connector_id, connector_epoch)
           VALUES (?, ?, ?)`,
        )
        .run(sessionId, epoch.connector_id, epoch.connector_epoch);
    }
    if (row.repository_mode === "MUTATING") {
      const guard = dependencies.database
        .query<{ id: string }, [string, string]>(
          `SELECT DISTINCT g.id FROM work_item_mutation_guards g
           LEFT JOIN mutation_guard_overrides o ON o.mutation_guard_id = g.id
           WHERE g.state = 'HELD' AND (g.run_id = ? OR o.colliding_run_id = ?)`,
        )
        .get(row.run_id, row.run_id);
      if (!guard) return error("MUTATION_GUARD_LOST", "Mutation Guard is unavailable.");
      dependencies.database
        .query(
          `INSERT INTO mutation_leases(
             id, session_id, run_id, attempt_id, mutation_guard_id, fence, state, revision,
             issued_at, expires_at, disconnect_grace_expires_at
           ) VALUES (?, ?, ?, ?, ?, 1, 'ACTIVE', 1, ?, ?, ?)`,
        )
        .run(
          dependencies.id("mutation_lease"),
          sessionId,
          row.run_id,
          row.attempt_id,
          guard.id,
          now,
          sessionExpiresAt,
          Math.min(sessionExpiresAt + row.mutation_disconnect_grace_seconds, row.deadline_at),
        );
    }
    dependencies.database
      .query(
        `UPDATE dispatch_permits
         SET state = 'CONSUMED', consumed_at = ?, revision = revision + 1 WHERE id = ?`,
      )
      .run(now, row.permit_id);
    const context = readSession(dependencies.database, sessionId);
    if (!context) return error("AUTHORITY_STORAGE_FAILED", "Authority Session is unavailable.");
    const result: CommandResult = { kind: "CONSUME_PERMIT", session: sessionView(context) };
    audit(dependencies, command, row.attempt_id, {
      sessionFence: 1,
      repositoryMode: row.repository_mode,
    });
    persistIdempotency(dependencies.database, command, inputHash, result, now);
    return { ok: true, value: result };
  });
}

function executeRenewSession(
  dependencies: AuthorityDependencies,
  command: Extract<CollabCommand, { kind: "RENEW_AUTHORITY_SESSION" }>,
  inputHash: string,
): Result<CommandResult> {
  const now = dependencies.clock();
  return inImmediateTransaction(dependencies.database, () => {
    const replay = storedResult(dependencies.database, command, inputHash);
    if (replay) return replay;
    const fenced = requireSessionFence(
      dependencies.database,
      command.sessionId,
      command.sessionFence,
      now,
    );
    if (!fenced.ok) return fenced;
    const session = fenced.value;
    if (
      command.actor.kind !== "RUNNER" ||
      command.actor.runnerId !== session.runnerId ||
      command.actor.runnerEpoch !== command.runnerEpoch ||
      command.runnerEpoch !== session.runnerEpoch
    ) {
      return error("RUNNER_EPOCH_CHANGED", "Runner authority changed.", "REFRESH");
    }
    const runner = dependencies.database
      .query<{ runner_epoch: number; revoked_at: number | null }, [string]>(
        "SELECT runner_epoch, revoked_at FROM runners WHERE id = ?",
      )
      .get(session.runnerId);
    if (!runner || runner.revoked_at !== null || runner.runner_epoch !== session.runnerEpoch) {
      return error("RUNNER_EPOCH_CHANGED", "Runner authority changed.", "REFRESH");
    }
    for (const [connectorId, epoch] of Object.entries(session.connectorEpochs)) {
      const current = dependencies.database
        .query<{ epoch: number; review_state: string }, [string]>(
          "SELECT epoch, review_state FROM connector_epochs WHERE connector_id = ?",
        )
        .get(connectorId);
      if (!current || current.epoch !== epoch || current.review_state !== "READY") {
        return error("CONNECTOR_REVOKED", "Connector authority changed.", "REFRESH");
      }
    }
    const expiresAt = Math.min(now + session.sessionSeconds, session.deadlineAt);
    dependencies.database
      .query(
        `UPDATE authority_sessions
         SET fence = fence + 1, revision = revision + 1, expires_at = ?, renewed_at = ?
         WHERE id = ? AND state = 'ACTIVE' AND fence = ?`,
      )
      .run(expiresAt, now, session.id, session.fence);
    if (session.repositoryMode === "MUTATING") {
      if (!session.lease || now >= session.lease.disconnectGraceExpiresAt) {
        return error("MUTATION_LEASE_LOST", "Mutation lease expired.", "EXPLICIT_RESUME");
      }
      dependencies.database
        .query(
          `UPDATE mutation_leases
           SET fence = fence + 1, revision = revision + 1, expires_at = ?,
               disconnect_grace_expires_at = ?, renewed_at = ?
           WHERE id = ? AND state = 'ACTIVE' AND fence = ?`,
        )
        .run(
          expiresAt,
          Math.min(expiresAt + session.disconnectGraceSeconds, session.deadlineAt),
          now,
          session.lease.id,
          session.lease.fence,
        );
    }
    const renewed = readSession(dependencies.database, session.id);
    if (!renewed) return error("AUTHORITY_STORAGE_FAILED", "Authority Session is unavailable.");
    const result: CommandResult = {
      kind: "RENEW_AUTHORITY_SESSION",
      session: sessionView(renewed),
    };
    audit(dependencies, command, session.attemptId, {
      sessionFence: renewed.fence,
      mutationLeaseFence: renewed.lease?.fence ?? 0,
    });
    persistIdempotency(dependencies.database, command, inputHash, result, now);
    return { ok: true, value: result };
  });
}

function executeAuthorizeOperation(
  dependencies: AuthorityDependencies,
  command: Extract<CollabCommand, { kind: "AUTHORIZE_OPERATION" }>,
  facts: RefreshedAuthorityFacts,
  inputHash: string,
): Result<CommandResult> {
  const now = dependencies.clock();
  return inImmediateTransaction(dependencies.database, () => {
    const replay = storedResult(dependencies.database, command, inputHash);
    if (replay) return replay;
    const fenced = requireSessionFence(
      dependencies.database,
      command.sessionId,
      command.sessionFence,
      now,
    );
    if (!fenced.ok) return fenced;
    const session = fenced.value;
    if (
      command.actor.kind !== "RUNNER" ||
      command.actor.runnerId !== session.runnerId ||
      command.actor.runnerEpoch !== session.runnerEpoch
    ) {
      return error("RUNNER_EPOCH_CHANGED", "Runner authority changed.", "REFRESH");
    }
    if (session.repositoryMode === "INSPECT_ONLY" && !inspectOnlyMayAuthorize(command.operation)) {
      return error("REPOSITORY_MODE_DENIED", "Inspect-only authority cannot perform writes.");
    }
    if (operationNeedsMutationLease(command.operation)) {
      if (!session.lease || now >= session.lease.expiresAt) {
        return error("MUTATION_LEASE_LOST", "Mutation lease expired.", "EXPLICIT_RESUME");
      }
    }
    if (
      (command.operation.kind === "MUTATE_REPOSITORY" ||
        command.operation.kind === "PUBLISH_GIT_REFERENCE") &&
      facts.currentHead !== command.operation.expectedHead
    ) {
      return error("REPOSITORY_REVISION_STALE", "Repository revision is stale.", "REFRESH");
    }
    const connector = operationConnector(command.operation);
    let connectorScopeId: string | null = null;
    let connectorScopeRevision: number | null = null;
    let connectorOperation: string | null = null;
    if (connector) {
      const guard =
        dependencies.database
          .query<{ count: number }, [string, string]>(
            `SELECT count(DISTINCT g.id) AS count FROM work_item_mutation_guards g
           LEFT JOIN mutation_guard_overrides o ON o.mutation_guard_id = g.id
           WHERE g.state = 'HELD' AND (g.run_id = ? OR o.colliding_run_id = ?)`,
          )
          .get(session.runId, session.runId)?.count ?? 0;
      if (guard !== 1) {
        return error("MUTATION_GUARD_LOST", "Work Item Mutation Guard is unavailable.");
      }
      const current = dependencies.database
        .query<{ epoch: number; review_state: string }, [string]>(
          "SELECT epoch, review_state FROM connector_epochs WHERE connector_id = ?",
        )
        .get(connector.connectorId);
      if (
        current?.review_state !== "READY" ||
        current.epoch !== connector.connectorEpoch ||
        session.connectorEpochs[connector.connectorId] !== connector.connectorEpoch ||
        facts.connectorEpochs[connector.connectorId] !== connector.connectorEpoch
      ) {
        return error("CONNECTOR_REVOKED", "Connector authority changed.", "REFRESH");
      }
      if (
        command.operation.kind !== "MUTATE_GITHUB" &&
        command.operation.kind !== "MUTATE_OUTLINE"
      ) {
        return error("OPERATION_INVALID", "Connector operation is invalid.");
      }
      const operationName = command.operation.mutation;
      const scope = dependencies.database
        .query<{ id: string; revision: number }, [string, string, number, string]>(
          `SELECT s.id, s.revision
           FROM connector_scopes s
           JOIN connector_scope_operations o ON o.scope_id = s.id
           WHERE s.project_id = ? AND s.connector_id = ? AND s.connector_epoch = ?
             AND s.revoked_at IS NULL AND o.operation = ?`,
        )
        .get(connector.projectId, connector.connectorId, connector.connectorEpoch, operationName);
      if (!scope) {
        return error("CONNECTOR_SCOPE_DENIED", "Connector operation is outside the granted scope.");
      }
      if (!(facts.connectorScopes?.[connector.connectorId] ?? []).includes(operationName)) {
        return error("CONNECTOR_SCOPE_STALE", "Connector scope facts are stale.", "REFRESH");
      }
      connectorScopeId = scope.id;
      connectorScopeRevision = scope.revision;
      connectorOperation = operationName;
    }
    if (command.operation.kind === "APPLY_APPROVAL_TRANSITION") {
      if (
        facts.approvalSubjects?.[command.operation.approvalSubjectId] !==
        command.operation.expectedSubjectDigest
      ) {
        return error("APPROVAL_STALE", "Approval subject is stale.", "REFRESH");
      }
    }
    const columns = operationColumns(command.operation);
    const authorizationId = dependencies.id("operation_authorization");
    const operationDigest = digestHex(
      JSON.stringify({
        sessionId: session.id,
        sessionFence: session.fence,
        mutationLeaseFence: session.lease?.fence,
        operation: command.operation,
      }),
    );
    const alreadyAuthorized =
      dependencies.database
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM operation_authorizations WHERE operation_digest = ?",
        )
        .get(operationDigest)?.count ?? 0;
    if (alreadyAuthorized > 0) {
      return error("OPERATION_ALREADY_AUTHORIZED", "Operation was already authorized.");
    }
    const expiresAt = Math.min(
      now + 10,
      session.expiresAt,
      session.lease?.expiresAt ?? session.expiresAt,
    );
    dependencies.database
      .query(
        `INSERT INTO operation_authorizations(
           id, session_id, session_fence, mutation_lease_fence, operation_kind,
           operation_digest, resource_id, expected_revision, connector_id, connector_epoch,
           connector_scope_id, connector_scope_revision, connector_operation, action_digest,
           state, revision, issued_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ISSUED', 1, ?, ?)`,
      )
      .run(
        authorizationId,
        session.id,
        session.fence,
        session.lease?.fence ?? null,
        command.operation.kind,
        operationDigest,
        columns.resourceId,
        columns.expectedRevision,
        columns.connectorId,
        columns.connectorEpoch,
        connectorScopeId,
        connectorScopeRevision,
        connectorOperation,
        columns.actionDigest,
        now,
        expiresAt,
      );
    const result: CommandResult = {
      kind: "AUTHORIZE_OPERATION",
      authorizationId,
      operationDigest,
      expiresAt,
    };
    audit(dependencies, command, session.attemptId, {
      operationKind: command.operation.kind,
      sessionFence: session.fence,
      mutationLeaseFence: session.lease?.fence ?? 0,
    });
    persistIdempotency(dependencies.database, command, inputHash, result, now);
    return { ok: true, value: result };
  });
}

function executeReleaseSession(
  dependencies: AuthorityDependencies,
  command: Extract<CollabCommand, { kind: "RELEASE_AUTHORITY_SESSION" }>,
  inputHash: string,
): Result<CommandResult> {
  const now = dependencies.clock();
  return inImmediateTransaction(dependencies.database, () => {
    const replay = storedResult(dependencies.database, command, inputHash);
    if (replay) return replay;
    const fenced = requireSessionFence(
      dependencies.database,
      command.sessionId,
      command.sessionFence,
      now,
    );
    if (!fenced.ok) return fenced;
    if (
      command.actor.kind !== "RUNNER" ||
      command.actor.runnerId !== fenced.value.runnerId ||
      command.actor.runnerEpoch !== fenced.value.runnerEpoch
    ) {
      return error("RUNNER_EPOCH_CHANGED", "Runner authority changed.", "REFRESH");
    }
    dependencies.database
      .query(
        `UPDATE authority_sessions SET state = 'RELEASED', released_at = ?, revision = revision + 1
         WHERE id = ? AND state = 'ACTIVE' AND fence = ?`,
      )
      .run(now, command.sessionId, command.sessionFence);
    dependencies.database
      .query(
        `UPDATE mutation_leases SET state = 'RELEASED', released_at = ?, revision = revision + 1
         WHERE session_id = ? AND state = 'ACTIVE'`,
      )
      .run(now, command.sessionId);
    const result: CommandResult = { kind: "RELEASE_AUTHORITY_SESSION", released: true };
    audit(dependencies, command, fenced.value.attemptId, { reason: command.reason });
    persistIdempotency(dependencies.database, command, inputHash, result, now);
    return { ok: true, value: result };
  });
}

function executeAttemptEvent(
  dependencies: AuthorityDependencies,
  command: Extract<CollabCommand, { kind: "ACCEPT_ATTEMPT_EVENT" }>,
  inputHash: string,
): Result<CommandResult> {
  const now = dependencies.clock();
  return inImmediateTransaction(dependencies.database, () => {
    const replay = storedResult(dependencies.database, command, inputHash);
    if (replay) return replay;
    const principal = requireActivePrincipal(dependencies.database, command.actor);
    if (!principal.ok) return principal;
    const currentAttempt = attemptView(dependencies.database, command.attemptId);
    const currentRun = runView(dependencies.database, command.runId);
    if (!currentAttempt || currentAttempt.runId !== command.runId || !currentRun) {
      return error("ATTEMPT_NOT_FOUND", "Execution Attempt was not found.");
    }
    if (
      currentRun.revision !== command.expectedRunRevision ||
      currentAttempt.revision !== command.expectedAttemptRevision
    ) {
      return error("LIFECYCLE_REVISION_STALE", "Lifecycle revision is stale.", "REFRESH");
    }
    if (command.actor.kind !== "RUNNER" || command.actor.runnerId !== currentAttempt.runnerId) {
      return error("RUNNER_ACTOR_MISMATCH", "Runner actor does not own this attempt.");
    }
    const transition = transitionAttempt(currentAttempt.state, command.event);
    if (!transition.ok) return transition;
    const next = transition.value;
    const terminal = ["EXITED", "FAILED_TO_START", "CANCELLED", "TIMED_OUT", "LOST"].includes(next);
    const acknowledgedAt = command.event.kind === "ACKNOWLEDGED" ? command.event.observedAt : null;
    const startedAt = command.event.kind === "PROCESS_STARTED" ? command.event.observedAt : null;
    const exitCode = command.event.kind === "PROCESS_EXITED" ? command.event.exitCode : null;
    const signal = command.event.kind === "PROCESS_EXITED" ? (command.event.signal ?? null) : null;
    const reasonCode =
      command.event.kind === "FAILED_TO_START"
        ? command.event.code
        : command.event.kind === "TERMINATION_REQUESTED"
          ? command.event.reason
          : null;
    const correlationId =
      command.event.kind === "PROCESS_EXITED" || command.event.kind === "FAILED_TO_START"
        ? (command.event.correlationId ?? null)
        : null;
    const terminalReason =
      next === "EXITED"
        ? "PROCESS_EXITED"
        : next === "FAILED_TO_START"
          ? "START_FAILED"
          : next === "CANCELLED"
            ? "CANCELLED"
            : next === "TIMED_OUT"
              ? "TIMED_OUT"
              : next === "LOST"
                ? "LOST"
                : null;
    dependencies.database
      .query(
        `UPDATE execution_attempts SET state = ?, revision = revision + 1,
           acknowledged_at = coalesce(acknowledged_at, ?), started_at = coalesce(started_at, ?),
           terminal_at = CASE WHEN ? THEN ? ELSE terminal_at END,
           exit_code = coalesce(?, exit_code), signal = coalesce(?, signal),
           terminal_reason = coalesce(?, terminal_reason)
         WHERE id = ? AND revision = ?`,
      )
      .run(
        next,
        acknowledgedAt,
        startedAt,
        terminal ? 1 : 0,
        command.event.observedAt,
        exitCode,
        signal,
        terminalReason,
        command.attemptId,
        command.expectedAttemptRevision,
      );
    dependencies.database
      .query(
        `INSERT INTO attempt_lifecycle_events(
           id, attempt_id, sequence, event_kind, from_state, to_state, reason_code,
           exit_code, signal, correlation_id, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        dependencies.id("attempt_event"),
        command.attemptId,
        nextSequence(
          dependencies.database,
          "attempt_lifecycle_events",
          "attempt_id",
          command.attemptId,
        ),
        command.event.kind,
        currentAttempt.state,
        next,
        reasonCode,
        exitCode,
        signal,
        correlationId,
        command.event.observedAt,
      );
    if (command.event.kind === "PROCESS_STARTED") {
      dependencies.database
        .query(
          `UPDATE agent_runs SET state = 'RUNNING', started_at = coalesce(started_at, ?),
             waiting_reason = NULL, revision = revision + 1 WHERE id = ?`,
        )
        .run(command.event.observedAt, command.runId);
    } else if (next === "LOST" || next === "FAILED_TO_START") {
      dependencies.database
        .query(
          `UPDATE agent_runs SET state = 'WAITING', waiting_reason = 'RETRY',
             started_at = coalesce(started_at, created_at), revision = revision + 1 WHERE id = ?`,
        )
        .run(command.runId);
      dependencies.database
        .query(
          `INSERT INTO run_lifecycle_events(
             id, run_id, sequence, event_kind, from_state, to_state, reason_code,
             actor_kind, actor_id, occurred_at
           ) VALUES (?, ?, ?, 'ATTEMPT_LOST', ?, 'WAITING', ?, ?, ?, ?)`,
        )
        .run(
          dependencies.id("run_event"),
          command.runId,
          nextSequence(dependencies.database, "run_lifecycle_events", "run_id", command.runId),
          currentRun.state,
          next,
          principal.value.kind,
          principal.value.id,
          command.event.observedAt,
        );
    }
    if (terminal) {
      dependencies.database
        .query(
          `UPDATE authority_sessions SET state = 'RELEASED', released_at = ?, revision = revision + 1
           WHERE attempt_id = ? AND state = 'ACTIVE'`,
        )
        .run(command.event.observedAt, command.attemptId);
      dependencies.database
        .query(
          `UPDATE mutation_leases SET state = 'RELEASED', released_at = ?, revision = revision + 1
           WHERE attempt_id = ? AND state = 'ACTIVE'`,
        )
        .run(command.event.observedAt, command.attemptId);
    }
    finalizeRunIfReady(
      dependencies,
      command.runId,
      { kind: principal.value.kind, id: principal.value.id },
      command.event.observedAt,
    );
    const run = runView(dependencies.database, command.runId);
    const attempt = attemptView(dependencies.database, command.attemptId);
    if (!run || !attempt)
      return error("AUTHORITY_STORAGE_FAILED", "Lifecycle state is unavailable.");
    const result: CommandResult = { kind: "ACCEPT_ATTEMPT_EVENT", run, attempt };
    audit(dependencies, command, command.attemptId, { eventKind: command.event.kind, state: next });
    persistIdempotency(dependencies.database, command, inputHash, result, now);
    return { ok: true, value: result };
  });
}

function executeCancelRun(
  dependencies: AuthorityDependencies,
  command: Extract<CollabCommand, { kind: "CANCEL_RUN" }>,
  inputHash: string,
): Result<CommandResult> {
  const now = dependencies.clock();
  return inImmediateTransaction(dependencies.database, () => {
    const replay = storedResult(dependencies.database, command, inputHash);
    if (replay) return replay;
    const principal = requireActivePrincipal(dependencies.database, command.actor);
    if (!principal.ok) return principal;
    const current = runView(dependencies.database, command.runId);
    if (!current) return error("RUN_NOT_FOUND", "Agent Run was not found.");
    if (current.revision !== command.expectedRunRevision) {
      return error("RUN_REVISION_STALE", "Agent Run revision is stale.", "REFRESH");
    }
    const transition = transitionRun(current.state, { kind: "CANCEL" });
    if (!transition.ok) return transition;
    const active = dependencies.database
      .query<{ id: string }, [string]>(
        `SELECT id FROM execution_attempts
         WHERE run_id = ? AND state IN ('PENDING', 'STARTING', 'RUNNING')
         ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(command.runId);
    dependencies.database
      .query(
        `UPDATE agent_runs SET state = 'CANCELLED', waiting_reason = NULL,
           terminal_reason = ?, started_at = coalesce(started_at, created_at),
           terminal_at = ?, revision = revision + 1 WHERE id = ?`,
      )
      .run(command.reason, now, command.runId);
    dependencies.database
      .query(
        `UPDATE dispatch_permits SET state = 'REVOKED', revoked_at = ?, revision = revision + 1
         WHERE state = 'ISSUED' AND attempt_id IN (
           SELECT id FROM execution_attempts WHERE run_id = ?
         )`,
      )
      .run(now, command.runId);
    dependencies.database
      .query(
        `UPDATE authority_sessions SET state = 'REVOKED', revoked_at = ?, revision = revision + 1
         WHERE state = 'ACTIVE' AND attempt_id IN (
           SELECT id FROM execution_attempts WHERE run_id = ?
         )`,
      )
      .run(now, command.runId);
    dependencies.database
      .query(
        `UPDATE mutation_leases SET state = 'REVOKED', revoked_at = ?, revision = revision + 1
         WHERE state = 'ACTIVE' AND run_id = ?`,
      )
      .run(now, command.runId);
    dependencies.database
      .query(
        `UPDATE operation_authorizations SET state = 'REVOKED', revoked_at = ?, revision = revision + 1
         WHERE state = 'ISSUED' AND session_id IN (
           SELECT s.id FROM authority_sessions s
           JOIN execution_attempts a ON a.id = s.attempt_id WHERE a.run_id = ?
         )`,
      )
      .run(now, command.runId);
    releaseGuardIfNoActiveParticipants(dependencies.database, command.runId, now);
    if (active) {
      const semanticDigest = digestHex(
        JSON.stringify({
          kind: "CANCEL_ATTEMPT",
          runId: command.runId,
          attemptId: active.id,
          reason: command.reason,
        }),
      );
      dependencies.database
        .query(
          `INSERT INTO authority_termination_intents(
             id, run_id, attempt_id, intent_kind, reason_code, semantic_digest,
             state, revision, created_at
           ) VALUES (?, ?, ?, 'CANCEL_ATTEMPT', ?, ?, 'PENDING', 1, ?)`,
        )
        .run(
          dependencies.id("termination_intent"),
          command.runId,
          active.id,
          command.reason,
          semanticDigest,
          now,
        );
    }
    dependencies.database
      .query(
        `INSERT INTO run_lifecycle_events(
           id, run_id, sequence, event_kind, from_state, to_state, reason_code,
           actor_kind, actor_id, occurred_at
         ) VALUES (?, ?, ?, 'CANCELLATION_REQUESTED', ?, 'CANCELLED', ?, ?, ?, ?)`,
      )
      .run(
        dependencies.id("run_event"),
        command.runId,
        nextSequence(dependencies.database, "run_lifecycle_events", "run_id", command.runId),
        current.state,
        command.reason,
        principal.value.kind,
        principal.value.id,
        now,
      );
    const run = runView(dependencies.database, command.runId);
    if (!run) return error("AUTHORITY_STORAGE_FAILED", "Agent Run state is unavailable.");
    const result: CommandResult = {
      kind: "CANCEL_RUN",
      run,
      termination: active
        ? {
            kind: "REQUEST_TERMINATION",
            request: {
              state: "REQUESTED",
              attemptId: active.id as never,
              reason:
                command.reason === "DEADLINE"
                  ? "DEADLINE"
                  : command.reason === "REVOCATION"
                    ? "REVOCATION"
                    : "CANCELLATION",
              requestedAt: now as never,
            },
          }
        : { kind: "NO_ACTIVE_ATTEMPT" },
    };
    audit(dependencies, command, command.runId, {
      reason: command.reason,
      terminationRequested: active !== undefined,
    });
    persistIdempotency(dependencies.database, command, inputHash, result, now);
    return { ok: true, value: result };
  });
}

function executeCheckpoint(
  dependencies: AuthorityDependencies,
  command: Extract<CollabCommand, { kind: "RECORD_CHECKPOINT" }>,
  inputHash: string,
): Result<CommandResult> {
  const now = dependencies.clock();
  return inImmediateTransaction(dependencies.database, () => {
    const replay = storedResult(dependencies.database, command, inputHash);
    if (replay) return replay;
    const currentRun = runView(dependencies.database, command.runId);
    const currentAttempt = attemptView(dependencies.database, command.attemptId);
    if (!currentRun || !currentAttempt || currentAttempt.runId !== command.runId) {
      return error("ATTEMPT_NOT_FOUND", "Execution Attempt was not found.");
    }
    if (currentRun.revision !== command.expectedRunRevision) {
      return error("RUN_REVISION_STALE", "Agent Run revision is stale.", "REFRESH");
    }
    if (command.actor.kind !== "RUNNER" || command.actor.runnerId !== currentAttempt.runnerId) {
      return error("RUNNER_ACTOR_MISMATCH", "Runner actor does not own this attempt.");
    }
    const durableRun = dependencies.database
      .query<{ worktree_identity: string }, [string]>(
        "SELECT worktree_identity FROM agent_runs WHERE id = ?",
      )
      .get(command.runId);
    if (
      command.runnerId !== currentAttempt.runnerId ||
      !durableRun ||
      command.worktreeIdentity !== durableRun.worktree_identity
    ) {
      return error("CHECKPOINT_ASSIGNMENT_MISMATCH", "Checkpoint assignment facts do not match.");
    }
    const checkpointId = dependencies.id("checkpoint");
    const checkpoint = createCheckpoint({
      id: checkpointId,
      runId: command.runId,
      attemptId: command.attemptId,
      reason: command.reason,
      requestedAction: command.requestedAction,
      summary: command.summary,
      runnerId: currentAttempt.runnerId,
      worktreeIdentity: durableRun.worktree_identity,
      ...(command.currentCommit ? { currentCommit: command.currentCommit } : {}),
      ...(command.recoverableRemoteReference
        ? { recoverableRemoteReference: command.recoverableRemoteReference }
        : {}),
      evidenceIds: command.evidenceIds,
      sourceRevisions: command.sourceRevisions,
      resumeGuidance: command.resumeGuidance,
      createdAt: now,
    });
    if (!checkpoint.ok) return checkpoint;
    const remote = command.recoverableRemoteReference;
    dependencies.database
      .query(
        `INSERT INTO run_checkpoints(
           id, run_id, attempt_id, reason, requested_action, summary, runner_id,
           worktree_identity, current_commit, published_remote_identity, published_remote_ref,
           published_commit, published_verified_at, resume_guidance, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkpointId,
        command.runId,
        command.attemptId,
        command.reason,
        command.requestedAction,
        command.summary,
        currentAttempt.runnerId,
        durableRun.worktree_identity,
        command.currentCommit ?? null,
        remote?.remoteIdentity ?? null,
        remote?.remoteRef ?? null,
        remote?.commitSha ?? null,
        remote?.verifiedAt ?? null,
        command.resumeGuidance,
        now,
      );
    for (const [index, evidenceId] of command.evidenceIds.entries()) {
      dependencies.database
        .query(
          "INSERT INTO checkpoint_evidence_links(checkpoint_id, evidence_id, ordinal) VALUES (?, ?, ?)",
        )
        .run(checkpointId, evidenceId, index + 1);
    }
    for (const [sourceKey, sourceRevision] of Object.entries(command.sourceRevisions)) {
      dependencies.database
        .query(
          `INSERT INTO checkpoint_source_revisions(checkpoint_id, source_key, source_revision)
           VALUES (?, ?, ?)`,
        )
        .run(checkpointId, sourceKey, sourceRevision);
    }
    const waitingReason =
      command.reason === "HUMAN_INPUT"
        ? "HUMAN_INPUT"
        : command.reason === "CANCELLATION"
          ? "BLOCKED"
          : "RETRY";
    dependencies.database
      .query(
        `UPDATE agent_runs SET state = 'WAITING', waiting_reason = ?,
           started_at = coalesce(started_at, created_at), revision = revision + 1 WHERE id = ?`,
      )
      .run(waitingReason, command.runId);
    dependencies.database
      .query(
        `UPDATE authority_sessions SET state = 'RELEASED', released_at = ?, revision = revision + 1
         WHERE attempt_id = ? AND state = 'ACTIVE'`,
      )
      .run(now, command.attemptId);
    dependencies.database
      .query(
        `UPDATE mutation_leases SET state = 'RELEASED', released_at = ?, revision = revision + 1
         WHERE attempt_id = ? AND state = 'ACTIVE'`,
      )
      .run(now, command.attemptId);
    const run = runView(dependencies.database, command.runId);
    if (!run) return error("AUTHORITY_STORAGE_FAILED", "Agent Run state is unavailable.");
    const result: CommandResult = { kind: "RECORD_CHECKPOINT", checkpoint: checkpoint.value, run };
    audit(dependencies, command, command.runId, {
      reason: command.reason,
      requestedAction: command.requestedAction,
    });
    persistIdempotency(dependencies.database, command, inputHash, result, now);
    return { ok: true, value: result };
  });
}

function executeEvidence(
  dependencies: AuthorityDependencies,
  command: Extract<CollabCommand, { kind: "RECORD_EVIDENCE" }>,
  inputHash: string,
): Result<CommandResult> {
  const now = dependencies.clock();
  return inImmediateTransaction(dependencies.database, () => {
    const replay = storedResult(dependencies.database, command, inputHash);
    if (replay) return replay;
    const run = runView(dependencies.database, command.runId);
    if (!run) return error("RUN_NOT_FOUND", "Agent Run was not found.");
    if (run.revision !== command.expectedRunRevision) {
      return error("RUN_REVISION_STALE", "Agent Run revision is stale.", "REFRESH");
    }
    if (!command.attemptId) {
      return error("ATTEMPT_REQUIRED", "Runner evidence must name its assigned attempt.");
    }
    if (command.attemptId) {
      const attempt = attemptView(dependencies.database, command.attemptId);
      if (!attempt || attempt.runId !== command.runId) {
        return error("ATTEMPT_NOT_FOUND", "Execution Attempt was not found.");
      }
      if (command.actor.kind !== "RUNNER" || command.actor.runnerId !== attempt.runnerId) {
        return error("RUNNER_ACTOR_MISMATCH", "Runner actor does not own this attempt.");
      }
    }
    const evidenceId = dependencies.id("evidence");
    const record = createEvidence({
      id: evidenceId,
      runId: command.runId,
      ...(command.attemptId ? { attemptId: command.attemptId } : {}),
      evidence: command.evidence,
      createdAt: now,
    });
    if (!record.ok) return record;
    const values: {
      summary: string | null;
      outcome: string | null;
      repositoryRevision: string | null;
      secondaryRevision: string | null;
      subjectId: string | null;
      gateKey: string | null;
      manifestFingerprint: string | null;
      remoteIdentity: string | null;
      remoteRef: string | null;
      observedAt: number | null;
      durationMs: number | null;
      filesChanged: number | null;
      additions: number | null;
      deletions: number | null;
      dirty: number | null;
      truncated: number | null;
      trackedClean: number | null;
      untrackedClean: number | null;
      publishedCommit: string | null;
      evidenceRevision: number | null;
      paths: readonly string[];
    } = {
      summary: null,
      outcome: null,
      repositoryRevision: null,
      secondaryRevision: null,
      subjectId: null,
      gateKey: null,
      manifestFingerprint: null,
      remoteIdentity: null,
      remoteRef: null,
      observedAt: null,
      durationMs: null,
      filesChanged: null,
      additions: null,
      deletions: null,
      dirty: null,
      truncated: null,
      trackedClean: null,
      untrackedClean: null,
      publishedCommit: null,
      evidenceRevision: null,
      paths: [],
    };
    switch (command.evidence.kind) {
      case "PUBLISHED_GIT_REFERENCE":
        values.remoteIdentity = command.evidence.remoteIdentity;
        values.remoteRef = command.evidence.remoteRef;
        values.repositoryRevision = command.evidence.commitSha;
        values.observedAt = command.evidence.verifiedAt;
        break;
      case "DIFF_STATS":
        values.repositoryRevision = command.evidence.baseCommit;
        values.secondaryRevision = command.evidence.headCommit;
        values.dirty = command.evidence.dirty ? 1 : 0;
        values.filesChanged = command.evidence.filesChanged;
        values.additions = command.evidence.additions;
        values.deletions = command.evidence.deletions;
        break;
      case "CHANGED_PATHS":
        values.repositoryRevision = command.evidence.baseCommit;
        values.observedAt = command.evidence.observedAt;
        values.truncated = command.evidence.truncated ? 1 : 0;
        values.paths = command.evidence.paths;
        break;
      case "GATE_EVALUATION":
        values.subjectId = command.evidence.gateEvaluationId;
        values.gateKey = command.evidence.gateKey;
        values.repositoryRevision = command.evidence.repositoryRevision;
        values.manifestFingerprint = command.evidence.manifestFingerprint;
        values.outcome = command.evidence.outcome;
        values.evidenceRevision = command.evidence.evidenceRevision;
        break;
      case "VERIFICATION":
        values.subjectId = command.evidence.name;
        values.outcome = command.evidence.outcome;
        values.durationMs = command.evidence.durationMs;
        values.summary = command.evidence.summary;
        break;
      case "ATTEMPT_OUTCOME":
        values.outcome = command.evidence.outcome;
        values.summary = command.evidence.reason;
        break;
      case "CLEANUP":
        values.outcome = command.evidence.disposition;
        values.trackedClean = command.evidence.trackedClean ? 1 : 0;
        values.untrackedClean = command.evidence.untrackedClean ? 1 : 0;
        values.publishedCommit = command.evidence.publishedCommit ?? null;
        break;
    }
    const evidenceDigest = digestHex(
      JSON.stringify({
        id: evidenceId,
        runId: command.runId,
        attemptId: command.attemptId,
        evidence: command.evidence,
      }),
    );
    dependencies.database
      .query(
        `INSERT INTO run_evidence(
           id, run_id, attempt_id, evidence_kind, summary, outcome, repository_revision,
           secondary_revision, subject_id, gate_key, manifest_fingerprint, remote_identity,
           remote_ref, observed_at, duration_ms, files_changed, additions, deletions, dirty,
           truncated, tracked_clean, untracked_clean, published_commit, evidence_revision,
           evidence_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evidenceId,
        command.runId,
        command.attemptId ?? null,
        command.evidence.kind,
        values.summary,
        values.outcome,
        values.repositoryRevision,
        values.secondaryRevision,
        values.subjectId,
        values.gateKey,
        values.manifestFingerprint,
        values.remoteIdentity,
        values.remoteRef,
        values.observedAt,
        values.durationMs,
        values.filesChanged,
        values.additions,
        values.deletions,
        values.dirty,
        values.truncated,
        values.trackedClean,
        values.untrackedClean,
        values.publishedCommit,
        values.evidenceRevision,
        evidenceDigest,
        now,
      );
    for (const [index, path] of values.paths.entries()) {
      dependencies.database
        .query(
          `INSERT INTO run_evidence_changed_paths(evidence_id, ordinal, repository_relative_path)
           VALUES (?, ?, ?)`,
        )
        .run(evidenceId, index + 1, path);
    }
    const result: CommandResult = { kind: "RECORD_EVIDENCE", evidence: record.value };
    audit(dependencies, command, command.runId, { evidenceKind: command.evidence.kind });
    persistIdempotency(dependencies.database, command, inputHash, result, now);
    return { ok: true, value: result };
  });
}

function executeRunResult(
  dependencies: AuthorityDependencies,
  command: Extract<CollabCommand, { kind: "RECORD_RUN_RESULT" }>,
  inputHash: string,
): Result<CommandResult> {
  const now = dependencies.clock();
  return inImmediateTransaction(dependencies.database, () => {
    const replay = storedResult(dependencies.database, command, inputHash);
    if (replay) return replay;
    const currentRun = runView(dependencies.database, command.runId);
    const attempt = attemptView(dependencies.database, command.attemptId);
    if (!currentRun || !attempt || attempt.runId !== command.runId) {
      return error("ATTEMPT_NOT_FOUND", "Execution Attempt was not found.");
    }
    if (currentRun.revision !== command.expectedRunRevision) {
      return error("RUN_REVISION_STALE", "Agent Run revision is stale.", "REFRESH");
    }
    if (command.actor.kind !== "RUNNER" || command.actor.runnerId !== attempt.runnerId) {
      return error("RUNNER_ACTOR_MISMATCH", "Runner actor does not own this attempt.");
    }
    const evaluated = evaluateRunResult(
      command.result === "BLOCKED" || command.result === "ESCALATED"
        ? {
            kind: command.result,
            summary: command.summary,
            reason: command.reason,
            requestedAction: command.requestedAction,
            evidenceIds: [...command.evidenceIds],
          }
        : {
            kind: command.result,
            summary: command.summary,
            evidenceIds: [...command.evidenceIds],
          },
    );
    if (!evaluated.ok) return evaluated;
    for (const evidenceId of command.evidenceIds) {
      const belongs =
        dependencies.database
          .query<{ count: number }, [string, string]>(
            "SELECT count(*) AS count FROM run_evidence WHERE id = ? AND run_id = ?",
          )
          .get(evidenceId, command.runId)?.count ?? 0;
      if (belongs !== 1) return error("EVIDENCE_NOT_FOUND", "Run Result evidence was not found.");
    }
    const resultId = dependencies.id("run_result");
    const evidenceDigest = digestHex(JSON.stringify([...command.evidenceIds]));
    dependencies.database
      .query(
        `INSERT INTO run_results(
           id, run_id, attempt_id, result_kind, summary, reason_code,
           requested_action, evidence_set_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        resultId,
        command.runId,
        command.attemptId,
        command.result,
        command.summary,
        command.result === "BLOCKED" || command.result === "ESCALATED" ? command.reason : null,
        command.result === "BLOCKED" || command.result === "ESCALATED"
          ? command.requestedAction
          : null,
        evidenceDigest,
        now,
      );
    for (const [index, evidenceId] of command.evidenceIds.entries()) {
      dependencies.database
        .query(
          "INSERT INTO run_result_evidence_links(result_id, evidence_id, ordinal) VALUES (?, ?, ?)",
        )
        .run(resultId, evidenceId, index + 1);
    }
    if (evaluated.value.state === "WAITING") {
      dependencies.database
        .query(
          `UPDATE agent_runs SET state = 'WAITING', waiting_reason = ?,
             started_at = coalesce(started_at, created_at), revision = revision + 1 WHERE id = ?`,
        )
        .run(evaluated.value.waitingReason ?? "BLOCKED", command.runId);
    }
    dependencies.database
      .query(
        `INSERT INTO run_lifecycle_events(
           id, run_id, sequence, event_kind, from_state, to_state, reason_code,
           actor_kind, actor_id, occurred_at
         ) VALUES (?, ?, ?, 'RESULT_RECORDED', ?, ?, ?, 'RUNNER', ?, ?)`,
      )
      .run(
        dependencies.id("run_event"),
        command.runId,
        nextSequence(dependencies.database, "run_lifecycle_events", "run_id", command.runId),
        currentRun.state,
        evaluated.value.state === "WAITING" ? "WAITING" : currentRun.state,
        command.result,
        command.actor.runnerId,
        now,
      );
    finalizeRunIfReady(
      dependencies,
      command.runId,
      { kind: "RUNNER", id: command.actor.runnerId },
      now,
    );
    const run = runView(dependencies.database, command.runId);
    if (!run) return error("AUTHORITY_STORAGE_FAILED", "Agent Run state is unavailable.");
    const result: CommandResult = { kind: "RECORD_RUN_RESULT", run };
    audit(dependencies, command, command.runId, { resultKind: command.result });
    persistIdempotency(dependencies.database, command, inputHash, result, now);
    return { ok: true, value: result };
  });
}

function currentRevocationEpoch(database: Database, command: ApplyRevocation): number | undefined {
  const source = command.source;
  switch (source.kind) {
    case "MEMBER":
      return database
        .query<{ epoch: number }, [string]>(
          "SELECT authority_epoch AS epoch FROM members WHERE id = ?",
        )
        .get(source.memberId)?.epoch;
    case "CONNECTOR":
      return database
        .query<{ epoch: number }, [string]>(
          "SELECT epoch FROM connector_epochs WHERE connector_id = ?",
        )
        .get(source.connectorId)?.epoch;
    case "RUNNER":
      return database
        .query<{ epoch: number }, [string]>(
          "SELECT runner_epoch AS epoch FROM runners WHERE id = ?",
        )
        .get(source.runnerId)?.epoch;
    case "EXPOSURE":
      return database
        .query<{ epoch: number }, [string]>(
          "SELECT revision AS epoch FROM runner_exposures WHERE id = ?",
        )
        .get(source.exposureId)?.epoch;
    case "RUN":
      return database
        .query<{ epoch: number }, [string]>("SELECT revision AS epoch FROM agent_runs WHERE id = ?")
        .get(source.runId)?.epoch;
    case "REPOSITORY":
      return source.revision;
  }
}

function revocationActorAuthorized(database: Database, command: ApplyRevocation): boolean {
  const actor = command.actor;
  const source = command.source;
  if (source.kind === "RUNNER") {
    if (actor.kind === "RUNNER") return actor.runnerId === source.runnerId;
    if (actor.kind !== "MEMBER") return false;
    return (
      database
        .query<{ count: number }, [string, string]>(
          "SELECT count(*) AS count FROM runners WHERE id = ? AND owner_member_id = ?",
        )
        .get(source.runnerId, actor.memberId)?.count === 1
    );
  }
  if (source.kind === "EXPOSURE") {
    return (
      actor.kind === "MEMBER" &&
      database
        .query<{ count: number }, [string, string]>(
          "SELECT count(*) AS count FROM runner_exposures WHERE id = ? AND owner_member_id = ?",
        )
        .get(source.exposureId, actor.memberId)?.count === 1
    );
  }
  if (source.kind === "RUN" && actor.kind === "SCHEDULER") {
    return (
      (database
        .query<{ count: number }, [string, string, string, string]>(
          `SELECT count(*) AS count FROM authority_snapshots
           WHERE run_id = ? AND actor_kind = 'SCHEDULER' AND actor_id = ?
             AND (? = '' OR actor_context_id = ?)`,
        )
        .get(
          source.runId,
          actor.originalDispatcherId,
          actor.workflowExecutionId ?? "",
          actor.workflowExecutionId ?? "",
        )?.count ?? 0) > 0
    );
  }
  if (actor.kind !== "MEMBER") return false;
  const member = database
    .query<{ role: string }, [string]>(
      "SELECT role FROM members WHERE id = ? AND status = 'ACTIVE'",
    )
    .get(actor.memberId);
  if (member?.role !== "OWNER") return false;
  return source.kind !== "MEMBER" || source.memberId !== actor.memberId;
}

function affectedAttempts(database: Database, command: ApplyRevocation): readonly string[] {
  const source = command.source;
  const query = (() => {
    switch (source.kind) {
      case "MEMBER":
        return {
          sql: `SELECT DISTINCT a.id FROM execution_attempts a
                JOIN authority_snapshots s ON s.attempt_id = a.id
                WHERE a.state IN ('PENDING', 'STARTING', 'RUNNING')
                  AND (s.actor_id = ? OR s.runner_owner_member_id = ?)`,
          params: [source.memberId, source.memberId],
        };
      case "CONNECTOR":
        return {
          sql: `SELECT DISTINCT s.attempt_id AS id FROM authority_sessions s
                JOIN authority_session_connector_epochs e ON e.session_id = s.id
                WHERE s.state = 'ACTIVE' AND e.connector_id = ?`,
          params: [source.connectorId],
        };
      case "RUNNER":
        return {
          sql: `SELECT id FROM execution_attempts
                WHERE state IN ('PENDING', 'STARTING', 'RUNNING') AND runner_id = ?`,
          params: [source.runnerId],
        };
      case "EXPOSURE":
        return {
          sql: `SELECT a.id FROM execution_attempts a
                JOIN authority_snapshots s ON s.attempt_id = a.id
                WHERE a.state IN ('PENDING', 'STARTING', 'RUNNING')
                  AND s.exposure_revision IS NOT NULL
                  AND EXISTS (SELECT 1 FROM runner_exposures e WHERE e.id = ? AND e.revision = s.exposure_revision)`,
          params: [source.exposureId],
        };
      case "REPOSITORY":
        return {
          sql: `SELECT a.id FROM execution_attempts a
                JOIN authority_snapshots s ON s.attempt_id = a.id
                WHERE a.state IN ('PENDING', 'STARTING', 'RUNNING') AND s.repository_id = ?`,
          params: [source.repositoryId],
        };
      case "RUN":
        return {
          sql: `SELECT id FROM execution_attempts
                WHERE state IN ('PENDING', 'STARTING', 'RUNNING') AND run_id = ?`,
          params: [source.runId],
        };
    }
  })();
  return database
    .query<{ id: string }, string[]>(query.sql)
    .all(...query.params)
    .map((row) => row.id);
}

function executeRevocation(
  dependencies: AuthorityDependencies,
  command: ApplyRevocation,
  inputHash: string,
): Result<CommandResult> {
  const now = dependencies.clock();
  return inImmediateTransaction(dependencies.database, () => {
    const replay = storedResult(dependencies.database, command, inputHash);
    if (replay) return replay;
    const principal = requireActivePrincipal(dependencies.database, command.actor);
    if (!principal.ok) return principal;
    if (!revocationActorAuthorized(dependencies.database, command)) {
      return error("REVOCATION_ACTOR_DENIED", "Actor cannot apply this revocation.");
    }
    const source = revocationSource(command);
    const currentEpoch = currentRevocationEpoch(dependencies.database, command);
    if (currentEpoch === undefined || currentEpoch !== source.epoch) {
      return error("REVOCATION_EPOCH_STALE", "Revocation epoch is stale.", "REFRESH");
    }
    if (source.epoch <= latestRevocationEpoch(dependencies.database, source.kind, source.id)) {
      return error("REVOCATION_EPOCH_STALE", "Revocation epoch is not monotonic.", "REFRESH");
    }
    const disposition =
      source.kind === "CONNECTOR"
        ? "REDUCE_AUTHORITY"
        : source.kind === "EXPOSURE"
          ? "DENY_FUTURE"
          : "REQUEST_TERMINATION";
    dependencies.database
      .query(
        `INSERT INTO authority_revocations(
           id, source_kind, source_id, source_epoch, actor_kind, actor_id, disposition, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        dependencies.id("revocation"),
        source.kind,
        source.id,
        source.epoch,
        safeActor(command.actor).kind,
        safeActor(command.actor).id,
        disposition,
        now,
      );
    const attempts = affectedAttempts(dependencies.database, command);
    for (const attemptId of attempts) {
      const row = dependencies.database
        .query<{ run_id: string }, [string]>("SELECT run_id FROM execution_attempts WHERE id = ?")
        .get(attemptId);
      if (!row) continue;
      dependencies.database
        .query(
          `UPDATE dispatch_permits SET state = 'REVOKED', revoked_at = ?, revision = revision + 1
           WHERE attempt_id = ? AND state = 'ISSUED'`,
        )
        .run(now, attemptId);
      if (source.kind !== "EXPOSURE") {
        dependencies.database
          .query(
            `UPDATE authority_sessions SET state = 'REVOKED', revoked_at = ?, revision = revision + 1
             WHERE attempt_id = ? AND state = 'ACTIVE'`,
          )
          .run(now, attemptId);
        dependencies.database
          .query(
            `UPDATE mutation_leases SET state = 'REVOKED', revoked_at = ?, revision = revision + 1
             WHERE attempt_id = ? AND state = 'ACTIVE'`,
          )
          .run(now, attemptId);
        const semanticDigest = digestHex(
          JSON.stringify({ kind: "CHECKPOINT_AND_TERMINATE", attemptId, source }),
        );
        dependencies.database
          .query(
            `INSERT OR IGNORE INTO authority_termination_intents(
               id, run_id, attempt_id, intent_kind, reason_code, semantic_digest,
               state, revision, created_at
             ) VALUES (?, ?, ?, 'CHECKPOINT_AND_TERMINATE', 'REVOCATION', ?, 'PENDING', 1, ?)`,
          )
          .run(dependencies.id("termination_intent"), row.run_id, attemptId, semanticDigest, now);
        dependencies.database
          .query(
            `UPDATE agent_runs SET state = 'WAITING', waiting_reason = 'DEPENDENCY',
               started_at = coalesce(started_at, created_at), revision = revision + 1
             WHERE id = ? AND state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
          )
          .run(row.run_id);
      }
    }
    const result: CommandResult = { kind: "APPLY_REVOCATION", applied: true };
    audit(dependencies, command, source.id, {
      sourceKind: source.kind,
      sourceEpoch: source.epoch,
      affectedAttempts: attempts.length,
    });
    persistIdempotency(dependencies.database, command, inputHash, result, now);
    return { ok: true, value: result };
  });
}

function executeReplacePolicy(
  dependencies: AuthorityDependencies,
  command: Extract<CollabCommand, { kind: "REPLACE_RUNNER_POLICY" }>,
  inputHash: string,
): Result<CommandResult> {
  const now = dependencies.clock();
  return inImmediateTransaction(dependencies.database, () => {
    const replay = storedResult(dependencies.database, command, inputHash);
    if (replay) return replay;
    const runner = dependencies.database
      .query<{ owner_member_id: string; policy_revision: number }, [string]>(
        "SELECT owner_member_id, policy_revision FROM runners WHERE id = ? AND revoked_at IS NULL",
      )
      .get(command.runnerId);
    if (
      !runner ||
      command.actor.kind !== "MEMBER" ||
      command.actor.memberId !== runner.owner_member_id
    ) {
      return error("RUNNER_OWNER_REQUIRED", "Only the runner owner may replace its policy.");
    }
    if (runner.policy_revision !== command.expectedPolicyRevision) {
      return error("RUNNER_POLICY_STALE", "Runner policy revision is stale.", "REFRESH");
    }
    const nextRevision = runner.policy_revision + 1;
    dependencies.database
      .query(
        `UPDATE runners SET dispatch_audience = ?, maximum_concurrent_attempts = ?,
           policy_revision = ?, revision = revision + 1 WHERE id = ?`,
      )
      .run(
        command.replacement.audience,
        command.replacement.maximumConcurrentAttempts,
        nextRevision,
        command.runnerId,
      );
    dependencies.database
      .query(
        `UPDATE dispatch_permits SET state = 'REVOKED', revoked_at = ?, revision = revision + 1
         WHERE state = 'ISSUED' AND attempt_id IN (
           SELECT id FROM execution_attempts WHERE runner_id = ?
         )`,
      )
      .run(now, command.runnerId);
    const result: CommandResult = {
      kind: "REPLACE_RUNNER_POLICY",
      runnerId: command.runnerId,
      policyRevision: nextRevision,
    };
    audit(dependencies, command, command.runnerId, {
      policyRevision: nextRevision,
      audience: command.replacement.audience,
    });
    persistIdempotency(dependencies.database, command, inputHash, result, now);
    return { ok: true, value: result };
  });
}

function executeSimpleCoordination(
  dependencies: AuthorityDependencies,
  command: Extract<
    CollabCommand,
    { kind: "LINK_SOURCE_REFERENCE" | "ACKNOWLEDGE_COLLISION" | "RECONCILE_OBSERVATION" }
  >,
  inputHash: string,
): Result<CommandResult> {
  const now = dependencies.clock();
  try {
    return inImmediateTransaction(dependencies.database, () => {
      const replay = storedResult(dependencies.database, command, inputHash);
      if (replay) return replay;
      const principal = requireActivePrincipal(dependencies.database, command.actor);
      if (!principal.ok) return principal;
      let result: CommandResult;
      if (command.kind === "LINK_SOURCE_REFERENCE") {
        const record = dependencies.database
          .query<{ project_id: string; revision: number }, [string]>(
            "SELECT project_id, revision FROM coordination_records WHERE id = ?",
          )
          .get(command.coordinationRecordId);
        if (!record)
          return error("COORDINATION_RECORD_NOT_FOUND", "Coordination Record was not found.");
        if (record.revision !== command.expectedRevision) {
          return error(
            "COORDINATION_REVISION_STALE",
            "Coordination Record revision is stale.",
            "REFRESH",
          );
        }
        linkSourceReferences(dependencies.database, {
          coordinationRecordId: command.coordinationRecordId,
          projectId: record.project_id,
          sourceRefs: [command.sourceRef],
          linkedAt: now,
        });
        dependencies.database
          .query(
            "UPDATE coordination_records SET revision = revision + 1, updated_at = ? WHERE id = ?",
          )
          .run(now, command.coordinationRecordId);
        const view = recordView(dependencies.database, command.coordinationRecordId);
        if (!view) return error("AUTHORITY_STORAGE_FAILED", "Coordination state is unavailable.");
        result = { kind: "LINK_SOURCE_REFERENCE", record: view };
      } else if (command.kind === "ACKNOWLEDGE_COLLISION") {
        const record = recordView(dependencies.database, command.coordinationRecordId);
        if (!record)
          return error("COORDINATION_RECORD_NOT_FOUND", "Coordination Record was not found.");
        if (record.revision !== command.expectedRevision) {
          return error(
            "COORDINATION_REVISION_STALE",
            "Coordination Record revision is stale.",
            "REFRESH",
          );
        }
        if (command.actor.kind !== "MEMBER") {
          return error("MEMBER_ACTOR_REQUIRED", "A Member must acknowledge a collision.");
        }
        const guarded = dependencies.database
          .query<{ revision: number; state: string; repository_mode: string }, [string, string]>(
            `SELECT revision, state, repository_mode FROM agent_runs
             WHERE id = ? AND coordination_record_id = ?`,
          )
          .get(command.guardedRunId, command.coordinationRecordId);
        const colliding = dependencies.database
          .query<{ revision: number; state: string; repository_mode: string }, [string, string]>(
            `SELECT revision, state, repository_mode FROM agent_runs
             WHERE id = ? AND coordination_record_id = ?`,
          )
          .get(command.collidingRunId, command.coordinationRecordId);
        const guard = dependencies.database
          .query<{ id: string; fence: number; revision: number }, [string, string]>(
            `SELECT id, fence, revision FROM work_item_mutation_guards
             WHERE coordination_record_id = ? AND run_id = ? AND state = 'HELD'`,
          )
          .get(command.coordinationRecordId, command.guardedRunId);
        if (
          !guarded ||
          !colliding ||
          !guard ||
          guarded.repository_mode !== "MUTATING" ||
          colliding.repository_mode !== "MUTATING" ||
          ["COMPLETED", "FAILED", "CANCELLED"].includes(guarded.state) ||
          ["COMPLETED", "FAILED", "CANCELLED"].includes(colliding.state)
        ) {
          return error("MUTATION_COLLISION_NOT_ACTIVE", "No active mutation collision exists.");
        }
        if (
          guarded.revision !== command.expectedGuardedRunRevision ||
          colliding.revision !== command.expectedCollidingRunRevision ||
          guard.fence !== command.expectedGuardFence ||
          guard.revision !== command.expectedGuardRevision
        ) {
          return error(
            "MUTATION_GUARD_OVERRIDE_STALE",
            "Mutation Guard override facts are stale.",
            "REFRESH",
          );
        }
        dependencies.database
          .query(
            `INSERT INTO mutation_guard_overrides(
               id, coordination_record_id, mutation_guard_id, guarded_run_id,
               guarded_run_revision, colliding_run_id, colliding_run_revision,
               guard_fence, guard_revision, actor_member_id, reason, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            dependencies.id("guard_override"),
            command.coordinationRecordId,
            guard.id,
            command.guardedRunId,
            command.expectedGuardedRunRevision,
            command.collidingRunId,
            command.expectedCollidingRunRevision,
            command.expectedGuardFence,
            command.expectedGuardRevision,
            command.actor.memberId,
            command.reason,
            now,
          );
        const changed = dependencies.database
          .query(
            `UPDATE work_item_mutation_guards SET fence = fence + 1, revision = revision + 1
             WHERE id = ? AND fence = ? AND revision = ? AND state = 'HELD'`,
          )
          .run(guard.id, command.expectedGuardFence, command.expectedGuardRevision);
        if (changed.changes !== 1) {
          return error(
            "MUTATION_GUARD_OVERRIDE_STALE",
            "Mutation Guard override facts are stale.",
            "REFRESH",
          );
        }
        dependencies.database
          .query(
            "UPDATE coordination_records SET revision = revision + 1, updated_at = ? WHERE id = ?",
          )
          .run(now, command.coordinationRecordId);
        const updated = recordView(dependencies.database, command.coordinationRecordId);
        if (!updated)
          return error("AUTHORITY_STORAGE_FAILED", "Coordination state is unavailable.");
        result = { kind: "ACKNOWLEDGE_COLLISION", record: updated };
      } else {
        const run = runView(dependencies.database, command.runId);
        if (!run) return error("RUN_NOT_FOUND", "Agent Run was not found.");
        if (run.revision !== command.expectedRunRevision) {
          return error("RUN_REVISION_STALE", "Agent Run revision is stale.", "REFRESH");
        }
        if (command.actor.kind === "RUNNER") {
          const assigned =
            dependencies.database
              .query<{ count: number }, [string, string]>(
                "SELECT count(*) AS count FROM execution_attempts WHERE run_id = ? AND runner_id = ?",
              )
              .get(command.runId, command.actor.runnerId)?.count ?? 0;
          if (assigned === 0) return error("NOT_FOUND", "Agent Run was not found.");
          if (command.observation.kind === "RUNNER_ATTEMPT") {
            const exactAttempt =
              dependencies.database
                .query<{ count: number }, [string, string, string]>(
                  `SELECT count(*) AS count FROM execution_attempts
                 WHERE id = ? AND run_id = ? AND runner_id = ?`,
                )
                .get(command.observation.attemptId, command.runId, command.actor.runnerId)?.count ??
              0;
            if (exactAttempt !== 1) return error("NOT_FOUND", "Execution Attempt was not found.");
          }
        } else if (command.actor.kind === "SCHEDULER") {
          const contextId = command.actor.workflowExecutionId ?? "";
          const scheduled =
            dependencies.database
              .query<{ count: number }, [string, string, string, string]>(
                `SELECT count(*) AS count FROM authority_snapshots
               WHERE run_id = ? AND actor_kind = 'SCHEDULER' AND actor_id = ?
                 AND (? = '' OR actor_context_id = ?)`,
              )
              .get(command.runId, command.actor.originalDispatcherId, contextId, contextId)
              ?.count ?? 0;
          if (scheduled === 0) return error("NOT_FOUND", "Agent Run was not found.");
        } else {
          const visible =
            dependencies.database
              .query<{ count: number }, [string, string]>(
                `SELECT count(*) AS count FROM authority_snapshots
                 WHERE run_id = ? AND actor_id = ?`,
              )
              .get(command.runId, command.actor.memberId)?.count ?? 0;
          if (visible === 0) return error("NOT_FOUND", "Agent Run was not found.");
        }
        if (command.observation.kind === "OUTBOX_DELIVERY") {
          const belongs =
            dependencies.database
              .query<{ count: number }, [string, string]>(
                `SELECT count(*) AS count FROM runner_dispatch_outbox o
               JOIN execution_attempts a ON a.id = o.attempt_id
               WHERE o.id = ? AND a.run_id = ?`,
              )
              .get(command.observation.deliveryId, command.runId)?.count ?? 0;
          if (belongs !== 1) return error("NOT_FOUND", "Delivery intent was not found.");
          const status =
            command.observation.disposition === "DELIVERED"
              ? "ACKNOWLEDGED"
              : command.observation.disposition === "PERMANENT_FAILURE"
                ? "FAILED"
                : "PENDING";
          const changed = dependencies.database
            .query(
              `UPDATE runner_dispatch_outbox SET status = ?,
                 acknowledged_at = CASE WHEN ? = 'ACKNOWLEDGED' THEN ? ELSE acknowledged_at END,
                 last_error_code = CASE WHEN ? = 'FAILED' THEN 'DELIVERY_FAILED' ELSE last_error_code END
               WHERE id = ?`,
            )
            .run(
              status,
              status,
              command.observation.observedAt,
              status,
              command.observation.deliveryId,
            );
          if (changed.changes !== 1)
            return error("OUTBOX_STATE_STALE", "Delivery intent state is stale.", "REFRESH");
        }
        result = { kind: "RECONCILE_OBSERVATION", reconciled: true };
      }
      audit(
        dependencies,
        command,
        command.kind === "RECONCILE_OBSERVATION" ? command.runId : command.coordinationRecordId,
        { operation: command.kind },
      );
      persistIdempotency(dependencies.database, command, inputHash, result, now);
      return { ok: true, value: result };
    });
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : "";
    if (code === "COORDINATION_SOURCE_CONFLICT") {
      return error(code, "Source reference belongs to another Coordination Record.");
    }
    return error("AUTHORITY_STORAGE_FAILED", "Coordination command failed.", "SAME_INPUT");
  }
}

function evidenceRecords(
  database: Database,
  runId: string,
  after: string | undefined,
  limit: number,
): readonly EvidenceRecord[] {
  const rows = database
    .query<
      {
        id: string;
        attempt_id: string | null;
        evidence_kind: string;
        summary: string | null;
        outcome: string | null;
        repository_revision: string | null;
        secondary_revision: string | null;
        subject_id: string | null;
        gate_key: string | null;
        manifest_fingerprint: string | null;
        remote_identity: string | null;
        remote_ref: string | null;
        observed_at: number | null;
        duration_ms: number | null;
        files_changed: number | null;
        additions: number | null;
        deletions: number | null;
        dirty: number | null;
        truncated: number | null;
        tracked_clean: number | null;
        untracked_clean: number | null;
        published_commit: string | null;
        evidence_revision: number | null;
        created_at: number;
      },
      [string, string, string, number]
    >(
      `SELECT * FROM run_evidence
       WHERE run_id = ? AND (? = '' OR id > ?)
       ORDER BY id LIMIT ?`,
    )
    .all(runId, after ?? "", after ?? "", limit);
  return rows.flatMap((row) => {
    const base = {
      id: row.id as never,
      runId: runId as never,
      ...(row.attempt_id ? { attemptId: row.attempt_id as never } : {}),
      createdAt: row.created_at as never,
    };
    switch (row.evidence_kind) {
      case "PUBLISHED_GIT_REFERENCE":
        if (
          !row.remote_identity ||
          !row.remote_ref ||
          !row.repository_revision ||
          row.observed_at === null
        )
          return [];
        return [
          {
            ...base,
            evidence: {
              kind: row.evidence_kind,
              remoteIdentity: row.remote_identity,
              remoteRef: row.remote_ref,
              commitSha: row.repository_revision,
              verifiedAt: row.observed_at,
            },
          } as EvidenceRecord,
        ];
      case "DIFF_STATS":
        if (
          !row.repository_revision ||
          !row.secondary_revision ||
          row.dirty === null ||
          row.files_changed === null ||
          row.additions === null ||
          row.deletions === null
        )
          return [];
        return [
          {
            ...base,
            evidence: {
              kind: row.evidence_kind,
              baseCommit: row.repository_revision,
              headCommit: row.secondary_revision,
              dirty: row.dirty === 1,
              filesChanged: row.files_changed,
              additions: row.additions,
              deletions: row.deletions,
            },
          } as EvidenceRecord,
        ];
      case "CHANGED_PATHS": {
        if (!row.repository_revision || row.observed_at === null || row.truncated === null)
          return [];
        const paths = database
          .query<{ repository_relative_path: string }, [string]>(
            "SELECT repository_relative_path FROM run_evidence_changed_paths WHERE evidence_id = ? ORDER BY ordinal",
          )
          .all(row.id)
          .map((path) => path.repository_relative_path);
        return [
          {
            ...base,
            evidence: {
              kind: row.evidence_kind,
              baseCommit: row.repository_revision,
              observedAt: row.observed_at,
              paths,
              truncated: row.truncated === 1,
            },
          } as EvidenceRecord,
        ];
      }
      case "GATE_EVALUATION":
        if (
          !row.subject_id ||
          !row.gate_key ||
          !row.repository_revision ||
          !row.manifest_fingerprint ||
          !row.outcome ||
          row.evidence_revision === null
        )
          return [];
        return [
          {
            ...base,
            evidence: {
              kind: row.evidence_kind,
              gateEvaluationId: row.subject_id,
              gateKey: row.gate_key,
              repositoryRevision: row.repository_revision,
              manifestFingerprint: row.manifest_fingerprint,
              outcome: row.outcome,
              evidenceRevision: row.evidence_revision,
            },
          } as EvidenceRecord,
        ];
      case "VERIFICATION":
        if (!row.subject_id || !row.outcome || row.duration_ms === null || !row.summary) return [];
        return [
          {
            ...base,
            evidence: {
              kind: row.evidence_kind,
              name: row.subject_id,
              outcome: row.outcome,
              durationMs: row.duration_ms,
              summary: row.summary,
            },
          } as EvidenceRecord,
        ];
      case "ATTEMPT_OUTCOME":
        if (!row.outcome || !row.summary) return [];
        return [
          {
            ...base,
            evidence: { kind: row.evidence_kind, outcome: row.outcome, reason: row.summary },
          } as EvidenceRecord,
        ];
      case "CLEANUP":
        if (!row.outcome || row.tracked_clean === null || row.untracked_clean === null) return [];
        return [
          {
            ...base,
            evidence: {
              kind: row.evidence_kind,
              disposition: row.outcome,
              trackedClean: row.tracked_clean === 1,
              untrackedClean: row.untracked_clean === 1,
              ...(row.published_commit ? { publishedCommit: row.published_commit } : {}),
            },
          } as EvidenceRecord,
        ];
      default:
        return [];
    }
  });
}

function executeQuery(
  dependencies: AuthorityDependencies,
  query: CoordinationQuery,
): Result<QueryResult> {
  const principal = requireActivePrincipal(dependencies.database, query.actor);
  if (!principal.ok) return principal;
  if (query.actor.kind === "RUNNER") {
    const allowed = (() => {
      switch (query.kind) {
        case "INSPECT_ATTEMPT":
          return dependencies.database
            .query<{ count: number }, [string, string]>(
              "SELECT count(*) AS count FROM execution_attempts WHERE id = ? AND runner_id = ?",
            )
            .get(query.attemptId, query.actor.runnerId)?.count;
        case "INSPECT_RUN":
        case "INSPECT_EVIDENCE":
          return dependencies.database
            .query<{ count: number }, [string, string]>(
              "SELECT count(*) AS count FROM execution_attempts WHERE run_id = ? AND runner_id = ?",
            )
            .get(query.runId, query.actor.runnerId)?.count;
        case "INSPECT_COORDINATION_RECORD":
        case "INSPECT_PROJECTION":
          return dependencies.database
            .query<{ count: number }, [string, string]>(
              `SELECT count(*) AS count FROM execution_attempts a
               JOIN agent_runs r ON r.id = a.run_id
               WHERE r.coordination_record_id = ? AND a.runner_id = ?`,
            )
            .get(query.coordinationRecordId, query.actor.runnerId)?.count;
      }
    })();
    if (!allowed) return error("NOT_FOUND", "Coordination state was not found.");
  }
  if (query.actor.kind === "SCHEDULER") {
    const contextId = query.actor.workflowExecutionId ?? "";
    const allowed = (() => {
      const suffix = `s.actor_kind = 'SCHEDULER' AND s.actor_id = ?
        AND (? = '' OR s.actor_context_id = ?)`;
      switch (query.kind) {
        case "INSPECT_ATTEMPT":
          return dependencies.database
            .query<{ count: number }, [string, string, string, string]>(
              `SELECT count(*) AS count FROM authority_snapshots s
               WHERE s.attempt_id = ? AND ${suffix}`,
            )
            .get(query.attemptId, query.actor.originalDispatcherId, contextId, contextId)?.count;
        case "INSPECT_RUN":
        case "INSPECT_EVIDENCE":
          return dependencies.database
            .query<{ count: number }, [string, string, string, string]>(
              `SELECT count(*) AS count FROM authority_snapshots s
               WHERE s.run_id = ? AND ${suffix}`,
            )
            .get(query.runId, query.actor.originalDispatcherId, contextId, contextId)?.count;
        case "INSPECT_COORDINATION_RECORD":
        case "INSPECT_PROJECTION":
          return dependencies.database
            .query<{ count: number }, [string, string, string, string]>(
              `SELECT count(*) AS count FROM authority_snapshots s
               JOIN agent_runs r ON r.id = s.run_id
               WHERE r.coordination_record_id = ? AND ${suffix}`,
            )
            .get(query.coordinationRecordId, query.actor.originalDispatcherId, contextId, contextId)
            ?.count;
      }
    })();
    if (!allowed) return error("NOT_FOUND", "Coordination state was not found.");
  }
  switch (query.kind) {
    case "INSPECT_COORDINATION_RECORD": {
      const record = recordView(dependencies.database, query.coordinationRecordId);
      return record
        ? { ok: true, value: { kind: query.kind, record } }
        : error("COORDINATION_RECORD_NOT_FOUND", "Coordination Record was not found.");
    }
    case "INSPECT_RUN": {
      const run = runView(dependencies.database, query.runId);
      return run
        ? { ok: true, value: { kind: query.kind, run } }
        : error("RUN_NOT_FOUND", "Agent Run was not found.");
    }
    case "INSPECT_ATTEMPT": {
      const attempt = attemptView(dependencies.database, query.attemptId);
      return attempt
        ? { ok: true, value: { kind: query.kind, attempt } }
        : error("ATTEMPT_NOT_FOUND", "Execution Attempt was not found.");
    }
    case "INSPECT_EVIDENCE": {
      const evidence = evidenceRecords(
        dependencies.database,
        query.runId,
        query.after,
        query.limit,
      );
      return {
        ok: true,
        value: {
          kind: query.kind,
          evidence,
          ...(evidence.length === query.limit ? { next: evidence.at(-1)?.id } : {}),
        },
      } as Result<QueryResult>;
    }
    case "INSPECT_PROJECTION": {
      const record = recordView(dependencies.database, query.coordinationRecordId);
      if (!record)
        return error("COORDINATION_RECORD_NOT_FOUND", "Coordination Record was not found.");
      const runs = record.runIds
        .map((runId) => runView(dependencies.database, runId))
        .filter((run): run is RunView => run !== undefined);
      const attempts = runs.flatMap((run) =>
        run.attemptIds
          .map((attemptId) => attemptView(dependencies.database, attemptId))
          .filter((attempt): attempt is AttemptView => attempt !== undefined),
      );
      return { ok: true, value: { kind: query.kind, projection: { record, runs, attempts } } };
    }
  }
}

export function createExecutionAuthority(dependencies: AuthorityDependencies): ExecutionAuthority {
  return {
    async preview(request) {
      const now = dependencies.clock();
      const parsed = AuthorityPreviewRequestSchema.safeParse(request);
      if (!parsed.success) {
        return {
          evaluatedAt: now as never,
          eligibleTargets: [],
          requirements: [
            {
              subject: "MEMBER",
              outcome: "DENIED",
              code: "AUTHORITY_PREVIEW_INVALID",
              summary: "Authority preview request is invalid.",
            },
          ],
          warnings: [],
        };
      }
      const previewRequest = parsed.data as AuthorityPreviewRequest;
      const external = await dependencies.authorityFacts.preview(previewRequest);
      const member = dependencies.database
        .query<{ status: string }, [string]>("SELECT status FROM members WHERE id = ?")
        .get(previewRequest.actor.memberId);
      const runner = dependencies.database
        .query<
          {
            id: string;
            runner_epoch: number;
            owner_member_id: string;
            dispatch_audience: "OWNER_ONLY" | "TEAM";
            policy_revision: number;
            security_policy_version: number;
            security_digest: string;
            revoked_at: number | null;
          },
          [string]
        >(
          `SELECT id, runner_epoch, owner_member_id, dispatch_audience, policy_revision,
                  security_policy_version, security_digest, revoked_at
           FROM runners WHERE id = ?`,
        )
        .get(previewRequest.execution.runnerId);
      const profile = dependencies.database
        .query<
          {
            fingerprint: string;
            supports_native: number;
            supports_orca: number;
            supports_headless: number;
            supports_interactive: number;
          },
          [string, string, number]
        >(
          `SELECT fingerprint, supports_native, supports_orca, supports_headless, supports_interactive
           FROM safe_profile_versions WHERE runner_id = ? AND profile_id = ? AND version = ?`,
        )
        .get(
          previewRequest.execution.runnerId,
          previewRequest.execution.profileVersionId,
          previewRequest.execution.expectedProfileVersion,
        );
      const mapping = dependencies.database
        .query<{ count: number }, [string, string, number]>(
          `SELECT count(*) AS count FROM runner_mapping_versions
           WHERE runner_id = ? AND project_id = ? AND revision = ? AND revoked_at IS NULL`,
        )
        .get(
          previewRequest.execution.runnerId,
          previewRequest.projectId,
          previewRequest.execution.projectMappingRevision,
        );
      const ownerAuthorized = runner?.owner_member_id === previewRequest.actor.memberId;
      const exposed =
        runner?.dispatch_audience === "TEAM" &&
        previewRequest.execution.exposureRevision !== undefined &&
        profile !== null &&
        dependencies.database
          .query<
            { count: number },
            [string, string, number, string, number, string, number, number, string, number]
          >(
            `SELECT count(*) AS count FROM runner_exposures e
             JOIN runner_exposure_acknowledgements a
               ON a.id = e.acknowledgement_id
              AND a.runner_id = e.runner_id
              AND a.owner_member_id = e.owner_member_id
              AND a.project_id = e.project_id
              AND a.mapping_revision = e.mapping_revision
              AND a.profile_id = e.profile_id
              AND a.profile_version = e.profile_version
              AND a.profile_fingerprint = e.profile_fingerprint
              AND a.policy_revision = e.policy_revision
              AND a.security_policy_version = e.security_policy_version
              AND a.security_digest = e.security_digest
             WHERE e.runner_id = ? AND e.project_id = ? AND e.mapping_revision = ?
               AND e.profile_id = ? AND e.profile_version = ? AND e.profile_fingerprint = ?
               AND e.policy_revision = ? AND e.security_policy_version = ? AND e.security_digest = ?
               AND e.revision = ? AND e.revoked_at IS NULL AND a.revoked_at IS NULL`,
          )
          .get(
            previewRequest.execution.runnerId,
            previewRequest.projectId,
            previewRequest.execution.projectMappingRevision,
            previewRequest.execution.profileVersionId,
            previewRequest.execution.expectedProfileVersion,
            profile.fingerprint,
            runner.policy_revision,
            runner.security_policy_version,
            runner.security_digest,
            previewRequest.execution.exposureRevision,
          )?.count === 1;
      const eligible =
        external.ok &&
        member?.status === "ACTIVE" &&
        runner !== null &&
        runner.revoked_at === null &&
        runner.runner_epoch === previewRequest.execution.expectedRunnerEpoch &&
        mapping?.count === 1 &&
        (ownerAuthorized || exposed) &&
        profile !== null &&
        profile.fingerprint === external.value.profileFingerprint &&
        (previewRequest.execution.host === "NATIVE"
          ? profile.supports_native === 1
          : profile.supports_orca === 1) &&
        (previewRequest.execution.interaction === "HEADLESS"
          ? profile.supports_headless === 1
          : profile.supports_interactive === 1);
      return {
        evaluatedAt: now as never,
        eligibleTargets: eligible
          ? [
              {
                runnerId: previewRequest.execution.runnerId,
                profileVersionId: previewRequest.execution.profileVersionId,
                host: previewRequest.execution.host,
                interaction: previewRequest.execution.interaction,
                assurance: previewRequest.repository.assurance,
              },
            ]
          : [],
        requirements: [
          {
            subject: "REPOSITORY",
            outcome: external.ok ? "ALLOWED" : "WAITING",
            code: external.ok ? "AUTHORITY_FACTS_REFRESHED" : "AUTHORITY_FACT_UNAVAILABLE",
            summary: external.ok
              ? "External authority facts were refreshed for preview."
              : "External authority facts are temporarily unavailable.",
          },
          {
            subject: "MEMBER",
            outcome: member?.status === "ACTIVE" ? "ALLOWED" : "DENIED",
            code: member?.status === "ACTIVE" ? "MEMBER_ACTIVE" : "MEMBER_REVOKED",
            summary:
              member?.status === "ACTIVE"
                ? "Member authority is active."
                : "Member authority is not active.",
          },
          {
            subject: "RUNNER",
            outcome: eligible ? "ALLOWED" : "DENIED",
            code: eligible ? "RUNNER_ELIGIBLE" : "RUNNER_UNAVAILABLE",
            summary: eligible
              ? "Runner selection is currently eligible."
              : "Runner selection is not currently eligible.",
          },
        ],
        warnings:
          previewRequest.repository.assurance === "ADVISORY"
            ? [
                {
                  subject: "REPOSITORY",
                  outcome: "ALLOWED",
                  code: "ADVISORY_HOST_BOUNDARY",
                  summary: "Advisory authority coordinates trusted runner behavior.",
                },
              ]
            : [],
      };
    },
    async execute(rawCommand) {
      const parsed = CollabCommandSchema.safeParse(rawCommand);
      if (!parsed.success) {
        return error("COMMAND_INVALID", "Execution Authority command is invalid.") as never;
      }
      const command = parsed.data as CollabCommand;
      if (!actorMayExecute(command)) {
        return error("ACTOR_NOT_AUTHORIZED", "Actor cannot execute this command.") as never;
      }
      const inputHash = digestHex(canonicalCommand(command));
      try {
        let refreshed: RefreshedAuthorityFacts | undefined;
        if (
          command.kind === "LAUNCH_RUN" ||
          command.kind === "AUTHORIZE_ATTEMPT" ||
          command.kind === "AUTHORIZE_OPERATION"
        ) {
          const facts = await dependencies.authorityFacts.refresh(command);
          if (!facts.ok) {
            return error(
              "AUTHORITY_FACT_UNAVAILABLE",
              "Required authority facts are unavailable.",
              "REFRESH",
            ) as never;
          }
          refreshed = facts.value;
        }
        switch (command.kind) {
          case "LAUNCH_RUN":
            if (!refreshed) {
              return error(
                "AUTHORITY_FACT_UNAVAILABLE",
                "Required authority facts are unavailable.",
                "REFRESH",
              ) as never;
            }
            return (await executeLaunch(dependencies, command, refreshed)) as never;
          case "AUTHORIZE_ATTEMPT":
            if (!refreshed) {
              return error(
                "AUTHORITY_FACT_UNAVAILABLE",
                "Required authority facts are unavailable.",
                "REFRESH",
              ) as never;
            }
            return (await executeAuthorizeAttempt(
              dependencies,
              command,
              refreshed,
              inputHash,
            )) as never;
          case "CANCEL_RUN":
            return executeCancelRun(dependencies, command, inputHash) as never;
          case "RECONCILE_OBSERVATION":
          case "LINK_SOURCE_REFERENCE":
          case "ACKNOWLEDGE_COLLISION":
            return executeSimpleCoordination(dependencies, command, inputHash) as never;
          case "ACCEPT_ATTEMPT_EVENT":
            return executeAttemptEvent(dependencies, command, inputHash) as never;
          case "RECORD_CHECKPOINT":
            return executeCheckpoint(dependencies, command, inputHash) as never;
          case "RECORD_EVIDENCE":
            return executeEvidence(dependencies, command, inputHash) as never;
          case "RECORD_RUN_RESULT":
            return executeRunResult(dependencies, command, inputHash) as never;
          case "CONSUME_PERMIT": {
            const verified = await dependencies.permitCodec.verify(command.permit);
            return (
              verified.ok
                ? executeConsumePermit(dependencies, command, verified.value, inputHash)
                : verified
            ) as never;
          }
          case "RENEW_AUTHORITY_SESSION":
            return executeRenewSession(dependencies, command, inputHash) as never;
          case "AUTHORIZE_OPERATION":
            if (!refreshed) {
              return error(
                "AUTHORITY_FACT_UNAVAILABLE",
                "Required authority facts are unavailable.",
                "REFRESH",
              ) as never;
            }
            return executeAuthorizeOperation(dependencies, command, refreshed, inputHash) as never;
          case "RELEASE_AUTHORITY_SESSION":
            return executeReleaseSession(dependencies, command, inputHash) as never;
          case "REPLACE_RUNNER_POLICY":
            return executeReplacePolicy(dependencies, command, inputHash) as never;
          case "APPLY_REVOCATION":
            return executeRevocation(dependencies, command, inputHash) as never;
        }
      } catch {
        return error(
          "AUTHORITY_STORAGE_FAILED",
          "Execution Authority command failed.",
          "SAME_INPUT",
        ) as never;
      }
    },
    async query(rawQuery) {
      const parsed = CoordinationQuerySchema.safeParse(rawQuery);
      if (!parsed.success) {
        return error("QUERY_INVALID", "Coordination query is invalid.") as never;
      }
      try {
        return executeQuery(dependencies, parsed.data as CoordinationQuery) as never;
      } catch {
        return error("QUERY_STORAGE_FAILED", "Coordination query failed.", "SAME_INPUT") as never;
      }
    },
  };
}
