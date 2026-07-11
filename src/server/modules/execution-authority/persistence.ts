import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AuthenticatedActor } from "../../../shared/contracts/actors.ts";
import { CollabCommandSchema, CommandResultSchema } from "../../../shared/contracts/commands.ts";
import type {
  AgentRunId,
  CoordinationRecordId,
  ExecutionAttemptId,
  RegisteredRunnerId,
} from "../../../shared/contracts/ids.ts";
import { IdentifierSchema } from "../../../shared/contracts/ids.ts";
import type { DomainError, Result } from "../../../shared/contracts/result.ts";
import type { AttemptView, RunView } from "../../../shared/contracts/runs.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import {
  coordinationRecordView,
  resolveCoordinationForLaunch,
} from "../coordination-records/registry.ts";
import {
  type CommittedLaunch,
  LaunchAuthorityFactsSchema,
  type LaunchPersistence,
  type LaunchPersistenceInput,
} from "./contract.ts";

export type { LaunchPersistenceInput } from "./contract.ts";

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
  digest?: (value: string) => Promise<Uint8Array>;
  afterWrite?: (table: string) => void;
}>;

type ProjectRow = Readonly<{ revision: number; base_branch: string }>;
type RunnerRow = Readonly<{
  owner_member_id: string;
  runner_epoch: number;
  policy_revision: number;
  security_policy_version: number;
  security_digest: string;
  revoked_at: number | null;
}>;

const StoredLaunchSchema = z
  .object({
    ok: z.literal(true),
    value: z
      .object({
        result: CommandResultSchema,
        outboxIds: z.array(IdentifierSchema).min(1).max(8),
      })
      .strict()
      .refine((value) => value.result.kind === "LAUNCH_RUN"),
  })
  .strict();

function error<T>(code: string, message: string, retry: DomainError["retry"] = "NEVER"): Result<T> {
  return { ok: false, error: { code, message, retry } };
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Bun.CryptoHasher("sha256").update(value).digest();
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function safeActor(actor: AuthenticatedActor): Readonly<{
  kind: "MEMBER" | "SCHEDULER" | "RUNNER";
  id: string;
  contextId?: string;
}> {
  if (actor.kind === "MEMBER") {
    return { kind: actor.kind, id: actor.memberId, contextId: actor.sessionId };
  }
  if (actor.kind === "SCHEDULER") {
    return {
      kind: actor.kind,
      id: actor.originalDispatcherId,
      ...(actor.workflowExecutionId ? { contextId: actor.workflowExecutionId } : {}),
    };
  }
  return { kind: actor.kind, id: actor.runnerId, contextId: String(actor.runnerEpoch) };
}

function canonicalLaunchInput(input: LaunchPersistenceInput): string {
  const actor = safeActor(input.command.actor);
  return JSON.stringify({
    operation: "LAUNCH_RUN",
    actor,
    projectId: input.command.projectId,
    coordination: input.command.coordination,
    goal: input.command.goal,
    repository: input.command.repository,
    execution: input.command.execution,
    effectiveConfiguration: input.command.effectiveConfiguration,
    ...(input.command.workflow ? { workflow: input.command.workflow } : {}),
  });
}

function replay(
  database: Database,
  actorId: string,
  storageKey: string,
  inputHash: string,
): Result<CommittedLaunch> | undefined {
  const row = database
    .query<{ input_hash: string; result_json: string }, [string, string]>(
      "SELECT input_hash, result_json FROM idempotency_results WHERE actor_id = ? AND idempotency_key = ?",
    )
    .get(actorId, storageKey);
  if (!row) return undefined;
  if (row.input_hash !== inputHash) {
    return error("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with different input.");
  }
  if (Buffer.byteLength(row.result_json, "utf8") > 64 * 1024) {
    return error("IDEMPOTENCY_STORAGE_INVALID", "Stored idempotency result is invalid.");
  }
  try {
    const parsed = StoredLaunchSchema.safeParse(JSON.parse(row.result_json));
    return parsed.success
      ? ({ ok: true, value: parsed.data.value as unknown as CommittedLaunch } as const)
      : error("IDEMPOTENCY_STORAGE_INVALID", "Stored idempotency result is invalid.");
  } catch {
    return error("IDEMPOTENCY_STORAGE_INVALID", "Stored idempotency result is invalid.");
  }
}

function currentFactsMatch(database: Database, input: LaunchPersistenceInput): boolean {
  const { command, authority } = input;
  const project = database
    .query<ProjectRow, [string]>("SELECT revision, base_branch FROM projects WHERE id = ?")
    .get(command.projectId);
  const runner = database
    .query<RunnerRow, [string]>(
      `SELECT owner_member_id, runner_epoch, policy_revision, security_policy_version,
              security_digest, revoked_at
       FROM runners WHERE id = ?`,
    )
    .get(command.execution.runnerId);
  const mapping = database
    .query<{ count: number }, [string, string, number]>(
      `SELECT count(*) AS count FROM runner_mapping_versions
       WHERE runner_id = ? AND project_id = ? AND revision = ? AND revoked_at IS NULL`,
    )
    .get(command.execution.runnerId, command.projectId, command.execution.projectMappingRevision);
  const profile = database
    .query<{ count: number }, [string, string, number, string]>(
      `SELECT count(*) AS count FROM safe_profile_versions
       WHERE runner_id = ? AND profile_id = ? AND version = ? AND fingerprint = ?`,
    )
    .get(
      command.execution.runnerId,
      command.execution.profileVersionId,
      command.execution.expectedProfileVersion,
      authority.profileFingerprint,
    );
  const exactBaseMatches =
    command.repository.base.kind !== "EXACT" ||
    command.repository.base.commitSha === authority.resolvedBaseCommit;
  if (
    !project ||
    project.revision !== authority.projectRevision ||
    project.base_branch !== authority.baseBranch ||
    !runner ||
    runner.revoked_at !== null ||
    runner.owner_member_id !== authority.runnerOwnerMemberId ||
    runner.runner_epoch !== command.execution.expectedRunnerEpoch ||
    runner.policy_revision !== authority.runnerPolicyRevision ||
    runner.security_policy_version !== authority.securityPolicyVersion ||
    runner.security_digest !== authority.securityDigest ||
    mapping?.count !== 1 ||
    profile?.count !== 1 ||
    authority.profileVersion !== command.execution.expectedProfileVersion ||
    !exactBaseMatches
  ) {
    return false;
  }
  if (authority.authorizationSource === "OWNER") {
    return command.execution.exposureRevision === undefined;
  }
  if (command.execution.exposureRevision === undefined) return false;
  const exposure = database
    .query<{ count: number }, [string, string, number, string, number, number]>(
      `SELECT count(*) AS count FROM runner_exposures
       WHERE runner_id = ? AND project_id = ? AND mapping_revision = ?
         AND profile_id = ? AND profile_version = ? AND revision = ? AND revoked_at IS NULL`,
    )
    .get(
      command.execution.runnerId,
      command.projectId,
      command.execution.projectMappingRevision,
      command.execution.profileVersionId,
      authority.profileVersion,
      command.execution.exposureRevision,
    );
  return exposure?.count === 1;
}

function runView(
  input: LaunchPersistenceInput,
  runId: string,
  recordId: string,
  attemptId: string,
): RunView {
  return {
    id: runId as AgentRunId,
    coordinationRecordId: recordId as CoordinationRecordId,
    state: "QUEUED",
    goal: input.command.goal,
    repositoryMode: input.command.repository.mode,
    repositoryAssurance: input.command.repository.assurance,
    revision: 1,
    attemptIds: [attemptId as ExecutionAttemptId],
  };
}

function attemptView(input: LaunchPersistenceInput, runId: string, attemptId: string): AttemptView {
  return {
    id: attemptId as ExecutionAttemptId,
    runId: runId as AgentRunId,
    runnerId: input.command.execution.runnerId as RegisteredRunnerId,
    state: "PENDING",
    revision: 1,
  };
}

export function createLaunchPersistence(dependencies: Dependencies): LaunchPersistence {
  const digest = dependencies.digest ?? sha256;
  const afterWrite = dependencies.afterWrite ?? (() => undefined);
  return {
    async create(rawInput) {
      const command = CollabCommandSchema.safeParse(rawInput.command);
      const authority = LaunchAuthorityFactsSchema.safeParse(rawInput.authority);
      if (
        !command.success ||
        command.data.kind !== "LAUNCH_RUN" ||
        !authority.success ||
        (command.data.repository.mode === "MUTATING" && !command.data.repository.intendedBranch)
      ) {
        return error("RUN_LAUNCH_INPUT_INVALID", "Run launch input is invalid.");
      }
      const input = { command: command.data, authority: authority.data } as LaunchPersistenceInput;
      const actor = safeActor(input.command.actor);
      const storageKey = `LAUNCH_RUN:${input.command.idempotencyKey}`;
      let inputHash: string;
      try {
        const hashedInput = await digest(canonicalLaunchInput(input));
        if (hashedInput.byteLength !== 32) throw new Error("INVALID_DIGEST");
        inputHash = hex(hashedInput);
      } catch {
        return error("RUN_LAUNCH_STORAGE_FAILED", "Run launch failed.", "SAME_INPUT");
      }
      const prior = replay(dependencies.database, actor.id, storageKey, inputHash);
      if (prior) return prior;

      const now = dependencies.clock();
      const ids = {
        coordination: dependencies.id("coordination"),
        run: dependencies.id("run"),
        attempt: dependencies.id("attempt"),
        worktree: dependencies.id("worktree"),
        snapshot: dependencies.id("snapshot"),
        permit: dependencies.id("permit"),
        outbox: dependencies.id("outbox"),
        audit: dependencies.id("audit"),
        guard: dependencies.id("guard"),
        guardOverride: dependencies.id("guard_override"),
      };
      if (
        !Number.isSafeInteger(now) ||
        now < 0 ||
        Object.values(ids).some((id) => !IdentifierSchema.safeParse(id).success)
      ) {
        return error("RUN_LAUNCH_STORAGE_FAILED", "Run launch failed.", "SAME_INPUT");
      }
      const snapshotCanonical = JSON.stringify({
        attemptId: ids.attempt,
        runId: ids.run,
        projectId: input.command.projectId,
        actor,
        execution: input.command.execution,
        repository: {
          ...input.command.repository,
          resolvedBaseCommit: input.authority.resolvedBaseCommit,
          baseBranch: input.authority.baseBranch,
        },
        effectiveConfiguration: input.command.effectiveConfiguration,
        authority: input.authority,
        createdAt: now,
      });
      let snapshotDigest: string;
      let claimsHash: string;
      let semanticDigest: string;
      let connectorEpochsDigest: string;
      try {
        const snapshotHash = await digest(snapshotCanonical);
        if (snapshotHash.byteLength !== 32) throw new Error("INVALID_DIGEST");
        snapshotDigest = hex(snapshotHash);
        const claims = await digest(
          JSON.stringify({
            kind: "DISPATCH_PERMIT",
            attemptId: ids.attempt,
            snapshotDigest,
            issuedAt: now,
            expiresAt: now + input.authority.permitSeconds,
          }),
        );
        const semantic = await digest(
          JSON.stringify({
            kind: "LAUNCH_ATTEMPT",
            attemptId: ids.attempt,
            runnerId: input.command.execution.runnerId,
            runnerEpoch: input.command.execution.expectedRunnerEpoch,
            snapshotId: ids.snapshot,
            permitId: ids.permit,
          }),
        );
        const connectorEpochs = await digest(JSON.stringify(input.authority.connectorEpochs));
        if (
          claims.byteLength !== 32 ||
          semantic.byteLength !== 32 ||
          connectorEpochs.byteLength !== 32
        )
          throw new Error("INVALID_DIGEST");
        claimsHash = hex(claims);
        semanticDigest = hex(semantic);
        connectorEpochsDigest = hex(connectorEpochs);
      } catch {
        return error("RUN_LAUNCH_STORAGE_FAILED", "Run launch failed.", "SAME_INPUT");
      }

      try {
        return inImmediateTransaction(dependencies.database, () => {
          const committedReplay = replay(dependencies.database, actor.id, storageKey, inputHash);
          if (committedReplay) return committedReplay;
          if (!currentFactsMatch(dependencies.database, input)) {
            return error("RUN_LAUNCH_FACTS_STALE", "Run launch facts are stale.", "REFRESH");
          }
          const record = resolveCoordinationForLaunch(dependencies.database, {
            selection: input.command.coordination,
            projectId: input.command.projectId,
            candidateId: ids.coordination,
            now,
            afterWrite,
          });
          const heldGuard =
            input.command.repository.mode === "MUTATING"
              ? dependencies.database
                  .query<{ id: string; run_id: string; fence: number; revision: number }, [string]>(
                    `SELECT id, run_id, fence, revision FROM work_item_mutation_guards
                     WHERE coordination_record_id = ? AND state = 'HELD'`,
                  )
                  .get(record.id)
              : null;
          if (input.command.repository.mode === "MUTATING" && heldGuard) {
            const override = input.command.mutationGuardOverride;
            const guardedRun = dependencies.database
              .query<{ revision: number; state: string }, [string]>(
                "SELECT revision, state FROM agent_runs WHERE id = ?",
              )
              .get(heldGuard.run_id);
            if (!override) throw new Error("MUTATION_GUARD_HELD");
            if (
              input.command.actor.kind !== "MEMBER" ||
              override.guardedRunId !== heldGuard.run_id ||
              override.expectedGuardedRunRevision !== guardedRun?.revision ||
              override.expectedGuardFence !== heldGuard.fence ||
              override.expectedGuardRevision !== heldGuard.revision ||
              !guardedRun ||
              ["COMPLETED", "FAILED", "CANCELLED"].includes(guardedRun.state)
            ) {
              throw new Error("MUTATION_GUARD_OVERRIDE_STALE");
            }
          } else if (input.command.mutationGuardOverride) {
            throw new Error("MUTATION_GUARD_OVERRIDE_INVALID");
          }
          const baseOrigin =
            input.command.repository.base.kind === "EXACT" ? "EXACT" : "RESOLVED_DEFAULT";
          dependencies.database
            .query<
              void,
              [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                string | null,
                string,
                string,
                number,
                string,
                string,
                string,
                string,
                string | null,
                number,
                number,
              ]
            >(
              `INSERT INTO agent_runs(
                 id, coordination_record_id, project_id, state, goal, repository_id,
                 repository_mode, repository_assurance, base_origin, base_commit, intended_branch,
                 base_branch, worktree_identity, effective_configuration_version,
                 effective_configuration_id, effective_configuration_digest,
                 dispatcher_kind, dispatcher_id, dispatcher_context_id, revision, created_at
               ) VALUES (?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              ids.run,
              record.id,
              input.command.projectId,
              input.command.goal,
              input.command.repository.repositoryId,
              input.command.repository.mode,
              input.command.repository.assurance,
              baseOrigin,
              input.authority.resolvedBaseCommit,
              input.command.repository.intendedBranch ?? null,
              input.authority.baseBranch,
              ids.worktree,
              input.command.effectiveConfiguration.version,
              input.command.effectiveConfiguration.configurationId,
              input.command.effectiveConfiguration.digest,
              actor.kind,
              actor.id,
              actor.contextId ?? null,
              1,
              now,
            );
          afterWrite("agent_runs");
          dependencies.database
            .query(
              `INSERT INTO run_execution_policies(
                 run_id, maximum_attempts, deadline_at, permit_seconds,
                 authority_session_seconds, authority_renewal_seconds,
                 mutation_disconnect_grace_seconds, connector_epochs_digest, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              ids.run,
              input.authority.maximumAttempts,
              input.authority.deadlineAt,
              input.authority.permitSeconds,
              input.authority.authoritySessionSeconds,
              input.authority.authorityRenewalSeconds,
              input.authority.mutationDisconnectGraceSeconds,
              connectorEpochsDigest,
              now,
            );
          afterWrite("run_execution_policies");
          for (const [connectorId, connectorEpoch] of Object.entries(
            input.authority.connectorEpochs,
          )) {
            dependencies.database
              .query(
                `INSERT INTO run_execution_connector_epochs(run_id, connector_id, connector_epoch)
                 VALUES (?, ?, ?)`,
              )
              .run(ids.run, connectorId, connectorEpoch);
          }
          if (Object.keys(input.authority.connectorEpochs).length > 0) {
            afterWrite("run_execution_connector_epochs");
          }
          if (input.command.repository.mode === "MUTATING") {
            if (!heldGuard) {
              dependencies.database
                .query(
                  `INSERT INTO work_item_mutation_guards(
                     id, coordination_record_id, run_id, fence, state, revision, reserved_at
                   ) VALUES (?, ?, ?, 1, 'HELD', 1, ?)`,
                )
                .run(ids.guard, record.id, ids.run, now);
              afterWrite("work_item_mutation_guards");
            } else {
              const override = input.command.mutationGuardOverride;
              if (!override) throw new Error("MUTATION_GUARD_OVERRIDE_INVALID");
              dependencies.database
                .query(
                  `INSERT INTO mutation_guard_overrides(
                     id, coordination_record_id, mutation_guard_id, guarded_run_id,
                     guarded_run_revision, colliding_run_id, colliding_run_revision,
                     guard_fence, guard_revision, actor_member_id, reason, created_at
                   ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
                )
                .run(
                  ids.guardOverride,
                  record.id,
                  heldGuard.id,
                  heldGuard.run_id,
                  override.expectedGuardedRunRevision,
                  ids.run,
                  heldGuard.fence,
                  heldGuard.revision,
                  actor.id,
                  override.reason,
                  now,
                );
              dependencies.database
                .query(
                  `UPDATE work_item_mutation_guards
                   SET fence = fence + 1, revision = revision + 1
                   WHERE id = ? AND fence = ? AND revision = ? AND state = 'HELD'`,
                )
                .run(heldGuard.id, heldGuard.fence, heldGuard.revision);
              afterWrite("mutation_guard_overrides");
            }
          }
          dependencies.database
            .query<
              void,
              [
                string,
                string,
                string,
                number,
                string,
                number,
                number,
                string,
                number,
                string,
                number | null,
                string,
                string,
                string,
                number,
                number,
              ]
            >(
              `INSERT INTO execution_attempts(
                 id, run_id, project_id, ordinal, runner_id, runner_epoch, mapping_revision,
                 profile_version_id, profile_version, profile_fingerprint, exposure_revision,
                 host, interaction, state, revision, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              ids.attempt,
              ids.run,
              input.command.projectId,
              1,
              input.command.execution.runnerId,
              input.command.execution.expectedRunnerEpoch,
              input.command.execution.projectMappingRevision,
              input.command.execution.profileVersionId,
              input.authority.profileVersion,
              input.authority.profileFingerprint,
              input.command.execution.exposureRevision ?? null,
              input.command.execution.host,
              input.command.execution.interaction,
              "PENDING",
              1,
              now,
            );
          afterWrite("execution_attempts");
          dependencies.database
            .query(
              `INSERT INTO authority_snapshots(
                 id, attempt_id, run_id, project_id, project_revision,
                 actor_kind, actor_id, actor_context_id, runner_id, runner_owner_member_id,
                 runner_epoch, runner_policy_revision, mapping_revision, profile_version_id,
                 profile_version, profile_fingerprint, exposure_revision, authorization_source,
                 security_policy_version, security_digest, repository_id, repository_mode,
                 repository_assurance, base_commit, base_branch, intended_branch,
                 effective_configuration_id, effective_configuration_version,
                 effective_configuration_digest, permit_seconds, authority_session_seconds,
                 authority_renewal_seconds, mutation_disconnect_grace_seconds,
                 snapshot_digest, created_at
               ) VALUES (
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?
               )`,
            )
            .run(
              ids.snapshot,
              ids.attempt,
              ids.run,
              input.command.projectId,
              input.authority.projectRevision,
              actor.kind,
              actor.id,
              actor.contextId ?? null,
              input.command.execution.runnerId,
              input.authority.runnerOwnerMemberId,
              input.command.execution.expectedRunnerEpoch,
              input.authority.runnerPolicyRevision,
              input.command.execution.projectMappingRevision,
              input.command.execution.profileVersionId,
              input.authority.profileVersion,
              input.authority.profileFingerprint,
              input.command.execution.exposureRevision ?? null,
              input.authority.authorizationSource,
              input.authority.securityPolicyVersion,
              input.authority.securityDigest,
              input.command.repository.repositoryId,
              input.command.repository.mode,
              input.command.repository.assurance,
              input.authority.resolvedBaseCommit,
              input.authority.baseBranch,
              input.command.repository.intendedBranch ?? null,
              input.command.effectiveConfiguration.configurationId,
              input.command.effectiveConfiguration.version,
              input.command.effectiveConfiguration.digest,
              input.authority.permitSeconds,
              input.authority.authoritySessionSeconds,
              input.authority.authorityRenewalSeconds,
              input.authority.mutationDisconnectGraceSeconds,
              snapshotDigest,
              now,
            );
          afterWrite("authority_snapshots");
          const expiresAt = now + input.authority.permitSeconds;
          dependencies.database
            .query<void, [string, string, string, string, string, number, number, number]>(
              `INSERT INTO dispatch_permits(
                 id, attempt_id, authority_snapshot_id, claims_hash, state, revision, issued_at, expires_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(ids.permit, ids.attempt, ids.snapshot, claimsHash, "ISSUED", 1, now, expiresAt);
          afterWrite("dispatch_permits");
          const run = runView(input, ids.run, record.id, ids.attempt);
          const attempt = attemptView(input, ids.run, ids.attempt);
          const result = {
            kind: "LAUNCH_RUN" as const,
            record: coordinationRecordView(dependencies.database, record),
            run,
            attempt,
            dispatch: {
              state: "QUEUED" as const,
              runnerId: input.command.execution.runnerId,
              attemptId: ids.attempt as ExecutionAttemptId,
              expiresAt: expiresAt as never,
            },
          };
          const committed: CommittedLaunch = { result, outboxIds: [ids.outbox] };
          dependencies.database
            .query<void, [string, string, string, string, string, string, number]>(
              `INSERT INTO audit_events(
                 id, kind, actor_kind, actor_id, subject_id, safe_details, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              ids.audit,
              "RUN_LAUNCHED",
              actor.kind,
              actor.id,
              ids.run,
              JSON.stringify({
                repositoryMode: input.command.repository.mode,
                host: input.command.execution.host,
                interaction: input.command.execution.interaction,
              }),
              now,
            );
          afterWrite("audit_events");
          dependencies.database
            .query<void, [string, string, string, string, number]>(
              `INSERT INTO idempotency_results(
                 actor_id, idempotency_key, input_hash, result_json, created_at
               ) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              actor.id,
              storageKey,
              inputHash,
              JSON.stringify({ ok: true, value: committed }),
              now,
            );
          afterWrite("idempotency_results");
          dependencies.database
            .query<void, [string, string, string, number, string, string, string, number, number]>(
              `INSERT INTO runner_dispatch_outbox(
                 id, delivery_kind, attempt_id, runner_id, runner_epoch,
                 authority_snapshot_id, permit_id, semantic_digest, status, created_at, expires_at
               ) VALUES (?, 'LAUNCH_ATTEMPT', ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
            )
            .run(
              ids.outbox,
              ids.attempt,
              input.command.execution.runnerId,
              input.command.execution.expectedRunnerEpoch,
              ids.snapshot,
              ids.permit,
              semanticDigest,
              now,
              expiresAt,
            );
          afterWrite("runner_dispatch_outbox");
          return { ok: true as const, value: committed };
        });
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : "";
        if (code === "COORDINATION_SOURCE_CONFLICT") {
          return error(code, "Source reference already belongs to another Coordination Record.");
        }
        if (code === "COORDINATION_SOURCE_INVALID") {
          return error("RUN_LAUNCH_INPUT_INVALID", "Run launch input is invalid.");
        }
        if (code === "COORDINATION_RECORD_NOT_FOUND") {
          return error(code, "Coordination Record was not found.");
        }
        if (code === "COORDINATION_REVISION_CONFLICT") {
          return error(code, "Coordination Record revision is stale.", "REFRESH");
        }
        if (code === "MUTATION_GUARD_HELD") {
          return error(code, "Work Item Mutation Guard is already held.", "EXPLICIT_RESUME");
        }
        if (code === "MUTATION_GUARD_OVERRIDE_STALE") {
          return error(code, "Mutation Guard override facts are stale.", "REFRESH");
        }
        if (code === "MUTATION_GUARD_OVERRIDE_INVALID") {
          return error(code, "Mutation Guard override is invalid.");
        }
        return error("RUN_LAUNCH_STORAGE_FAILED", "Run launch failed.", "SAME_INPUT");
      }
    },
  };
}
