import type { Database } from "bun:sqlite";
import type { Result } from "../shared/contracts/result.ts";
import type { CleanupRetentionReason } from "../shared/contracts/runs.ts";
import type { HostProcess } from "./execution-contract.ts";

export type ProcessReservation = Readonly<{
  reservationId: string;
  disposition: "NEW" | "RESUME" | "RECONCILE";
}>;

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

export function createLocalProcessRegistry(
  database: Database,
  clock: () => number,
  id: () => string,
) {
  return {
    reserve(attemptId: string, assignmentDigest: string): Result<ProcessReservation> {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(attemptId) ||
        !/^[0-9a-f]{64}$/.test(assignmentDigest)
      ) {
        return failure("PROCESS_ASSIGNMENT_INVALID", "Process assignment is invalid.");
      }
      const existing = database
        .query<{ reservation_id: string; assignment_digest: string; state: string }, [string]>(
          "SELECT reservation_id, assignment_digest, state FROM local_processes WHERE attempt_id = ?",
        )
        .get(attemptId);
      if (existing) {
        return existing.assignment_digest === assignmentDigest
          ? {
              ok: true,
              value: {
                reservationId: existing.reservation_id,
                disposition: existing.state === "RESERVED" ? "RESUME" : "RECONCILE",
              },
            }
          : failure("PROCESS_ASSIGNMENT_CONFLICT", "Process assignment changed.");
      }
      const reservationId = id();
      try {
        database
          .query(
            `INSERT INTO local_processes(
               attempt_id, reservation_id, assignment_digest, state, created_at, updated_at
             ) VALUES (?, ?, ?, 'RESERVED', ?, ?)`,
          )
          .run(attemptId, reservationId, assignmentDigest, clock(), clock());
        return { ok: true, value: { reservationId, disposition: "NEW" } };
      } catch {
        return failure("PROCESS_STATE_FAILED", "Local process state failed.");
      }
    },

    release(reservation: ProcessReservation): Result<void> {
      try {
        const changed = database
          .query("DELETE FROM local_processes WHERE reservation_id = ? AND state = 'RESERVED'")
          .run(reservation.reservationId);
        return changed.changes === 1
          ? { ok: true, value: undefined }
          : failure("PROCESS_STATE_CONFLICT", "Local process state changed.");
      } catch {
        return failure("PROCESS_STATE_FAILED", "Local process state failed.");
      }
    },

    recordFailed(reservation: ProcessReservation, disposition: string): Result<void> {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(disposition)) {
        return failure("PROCESS_DISPOSITION_INVALID", "Process disposition is invalid.");
      }
      try {
        const changed = database
          .query(
            `UPDATE local_processes SET state = 'FAILED_TO_START', last_disposition = ?, updated_at = ?
             WHERE reservation_id = ? AND state IN ('RESERVED', 'STARTING')`,
          )
          .run(disposition, clock(), reservation.reservationId);
        return changed.changes === 1
          ? { ok: true, value: undefined }
          : failure("PROCESS_STATE_CONFLICT", "Local process state changed.");
      } catch {
        return failure("PROCESS_STATE_FAILED", "Local process state failed.");
      }
    },

    markStarting(reservation: ProcessReservation): Result<void> {
      try {
        const changed = database
          .query(
            `UPDATE local_processes SET state = 'STARTING', updated_at = ?
             WHERE reservation_id = ? AND state = 'RESERVED'`,
          )
          .run(clock(), reservation.reservationId);
        return changed.changes === 1
          ? { ok: true, value: undefined }
          : failure("PROCESS_STATE_CONFLICT", "Local process state changed.");
      } catch {
        return failure("PROCESS_STATE_FAILED", "Local process state failed.");
      }
    },

    recordStarted(reservation: ProcessReservation, identity: HostProcess): Result<void> {
      try {
        const changed = database
          .query(
            `UPDATE local_processes SET state = 'STARTED', host = ?, opaque_process_id = ?,
               interaction = ?, assurance = ?, updated_at = ?
             WHERE reservation_id = ? AND state = 'STARTING'`,
          )
          .run(
            identity.host,
            identity.opaqueProcessId,
            identity.interaction,
            identity.assurance,
            clock(),
            reservation.reservationId,
          );
        return changed.changes === 1
          ? { ok: true, value: undefined }
          : failure("PROCESS_STATE_CONFLICT", "Local process state changed.");
      } catch {
        return failure("PROCESS_STATE_FAILED", "Local process state failed.");
      }
    },

    inspect(attemptId: string): Result<
      Readonly<{
        state: "RESERVED" | "STARTING" | "STARTED" | "FAILED_TO_START" | "EXITED" | "UNKNOWN";
        assignmentDigest: string;
        opaqueProcessId: string | null;
      }>
    > {
      const row = database
        .query<
          {
            state: "RESERVED" | "STARTING" | "STARTED" | "FAILED_TO_START" | "EXITED" | "UNKNOWN";
            assignment_digest: string;
            opaque_process_id: string | null;
          },
          [string]
        >(
          "SELECT state, assignment_digest, opaque_process_id FROM local_processes WHERE attempt_id = ?",
        )
        .get(attemptId);
      return row
        ? {
            ok: true,
            value: {
              state: row.state,
              assignmentDigest: row.assignment_digest,
              opaqueProcessId: row.opaque_process_id,
            },
          }
        : failure("PROCESS_NOT_FOUND", "Local process was not found.");
    },
  };
}

export type LocalWorktreeState = "CREATING" | "READY" | "RETAINED" | "REMOVED" | "DISCARDED";

export type LocalWorktreeRecord = Readonly<{
  runId: string;
  worktreeKey: string;
  projectId: string;
  repositoryId: string;
  runnerId: string;
  ownerMemberId: string;
  repositoryRoot: string;
  worktreePath: string;
  baseCommit: string;
  branchRef: string;
  remoteName: string;
  remoteIdentity: string;
  remoteRef: string;
  state: LocalWorktreeState;
  pinnedRunRevision: number | null;
  currentHead: string | null;
  publishedCommit: string | null;
  publishedVerifiedAt: number | null;
  retainedWorkId: string | null;
  retainedReason: CleanupRetentionReason | null;
  observationRevision: number;
  observationDigest: string | null;
  summaryJson: string | null;
  createdAt: number;
  updatedAt: number;
}>;

export type LocalWorktreeReservation = Readonly<{
  runId: string;
  worktreeKey: string;
  projectId: string;
  repositoryId: string;
  runnerId: string;
  ownerMemberId: string;
  repositoryRoot: string;
  worktreePath: string;
  baseCommit: string;
  branchRef: string;
  remoteName: string;
  remoteIdentity: string;
  remoteRef: string;
}>;

type LocalWorktreeRow = Readonly<{
  run_id: string;
  worktree_key: string;
  project_id: string;
  repository_id: string;
  runner_id: string;
  owner_member_id: string;
  repository_root: string;
  worktree_path: string;
  base_commit: string;
  branch_ref: string;
  remote_name: string;
  remote_identity: string;
  remote_ref: string;
  state: LocalWorktreeState;
  pinned_run_revision: number | null;
  current_head: string | null;
  published_commit: string | null;
  published_verified_at: number | null;
  retained_work_id: string | null;
  retained_reason: CleanupRetentionReason | null;
  observation_revision: number;
  observation_digest: string | null;
  summary_json: string | null;
  created_at: number;
  updated_at: number;
}>;

function worktreeRecord(row: LocalWorktreeRow): LocalWorktreeRecord {
  return {
    runId: row.run_id,
    worktreeKey: row.worktree_key,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    runnerId: row.runner_id,
    ownerMemberId: row.owner_member_id,
    repositoryRoot: row.repository_root,
    worktreePath: row.worktree_path,
    baseCommit: row.base_commit,
    branchRef: row.branch_ref,
    remoteName: row.remote_name,
    remoteIdentity: row.remote_identity,
    remoteRef: row.remote_ref,
    state: row.state,
    pinnedRunRevision: row.pinned_run_revision,
    currentHead: row.current_head,
    publishedCommit: row.published_commit,
    publishedVerifiedAt: row.published_verified_at,
    retainedWorkId: row.retained_work_id,
    retainedReason: row.retained_reason,
    observationRevision: row.observation_revision,
    observationDigest: row.observation_digest,
    summaryJson: row.summary_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sameWorktreeReservation(
  row: LocalWorktreeRecord,
  input: LocalWorktreeReservation,
): boolean {
  return (
    row.runId === input.runId &&
    row.projectId === input.projectId &&
    row.repositoryId === input.repositoryId &&
    row.runnerId === input.runnerId &&
    row.ownerMemberId === input.ownerMemberId &&
    row.repositoryRoot === input.repositoryRoot &&
    row.worktreePath === input.worktreePath &&
    row.baseCommit === input.baseCommit &&
    row.branchRef === input.branchRef &&
    row.remoteName === input.remoteName &&
    row.remoteIdentity === input.remoteIdentity &&
    row.remoteRef === input.remoteRef
  );
}

export function createLocalWorktreeRegistry(
  database: Database,
  clock: () => number,
  id: (kind: "retained_work") => string,
) {
  const selectByKey = database.query<LocalWorktreeRow, [string]>(
    `SELECT * FROM local_run_worktrees WHERE worktree_key = ?`,
  );
  const selectByRun = database.query<LocalWorktreeRow, [string]>(
    `SELECT * FROM local_run_worktrees WHERE run_id = ?`,
  );

  return {
    inspectByKey(worktreeKey: string): Result<LocalWorktreeRecord> {
      const row = selectByKey.get(worktreeKey);
      return row
        ? { ok: true, value: worktreeRecord(row) }
        : failure("WORKTREE_NOT_FOUND", "Managed worktree was not found.");
    },

    inspectByRun(runId: string): Result<LocalWorktreeRecord> {
      const row = selectByRun.get(runId);
      return row
        ? { ok: true, value: worktreeRecord(row) }
        : failure("WORKTREE_NOT_FOUND", "Managed worktree was not found.");
    },

    reserve(input: LocalWorktreeReservation): Result<LocalWorktreeRecord> {
      const existing = selectByRun.get(input.runId);
      if (existing) {
        const value = worktreeRecord(existing);
        return sameWorktreeReservation(value, input)
          ? { ok: true, value }
          : failure("WORKTREE_ASSIGNMENT_CONFLICT", "Managed worktree assignment changed.");
      }
      const now = clock();
      try {
        database
          .query(
            `INSERT INTO local_run_worktrees(
               run_id, worktree_key, project_id, repository_id, runner_id, owner_member_id,
               repository_root, worktree_path, base_commit, branch_ref, remote_name,
               remote_identity, remote_ref, state, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATING', ?, ?)`,
          )
          .run(
            input.runId,
            input.worktreeKey,
            input.projectId,
            input.repositoryId,
            input.runnerId,
            input.ownerMemberId,
            input.repositoryRoot,
            input.worktreePath,
            input.baseCommit,
            input.branchRef,
            input.remoteName,
            input.remoteIdentity,
            input.remoteRef,
            now,
            now,
          );
        const created = selectByRun.get(input.runId);
        if (!created) return failure("WORKTREE_STATE_FAILED", "Managed worktree state failed.");
        return { ok: true, value: worktreeRecord(created) };
      } catch {
        return failure("WORKTREE_ASSIGNMENT_CONFLICT", "Managed worktree assignment changed.");
      }
    },

    markReady(worktreeKey: string, head: string): Result<LocalWorktreeRecord> {
      try {
        const changed = database
          .query(
            `UPDATE local_run_worktrees
             SET state = 'READY', current_head = ?, updated_at = ?
             WHERE worktree_key = ? AND state = 'CREATING'`,
          )
          .run(head, clock(), worktreeKey);
        if (changed.changes !== 1) {
          const existing = selectByKey.get(worktreeKey);
          if (existing?.state === "READY" && existing.current_head === head) {
            return { ok: true, value: worktreeRecord(existing) };
          }
          return failure("WORKTREE_STATE_CONFLICT", "Managed worktree state changed.");
        }
        const row = selectByKey.get(worktreeKey);
        return row
          ? { ok: true, value: worktreeRecord(row) }
          : failure("WORKTREE_STATE_FAILED", "Managed worktree state failed.");
      } catch {
        return failure("WORKTREE_STATE_FAILED", "Managed worktree state failed.");
      }
    },

    markPinned(worktreeKey: string, runRevision: number): Result<LocalWorktreeRecord> {
      try {
        const changed = database
          .query(
            `UPDATE local_run_worktrees SET pinned_run_revision = ?, updated_at = ?
             WHERE worktree_key = ? AND state = 'READY' AND pinned_run_revision IS NULL`,
          )
          .run(runRevision, clock(), worktreeKey);
        if (changed.changes !== 1) {
          const existing = selectByKey.get(worktreeKey);
          if (existing?.pinned_run_revision === runRevision) {
            return { ok: true, value: worktreeRecord(existing) };
          }
          return failure("WORKTREE_STATE_CONFLICT", "Managed worktree state changed.");
        }
        const row = selectByKey.get(worktreeKey);
        return row
          ? { ok: true, value: worktreeRecord(row) }
          : failure("WORKTREE_STATE_FAILED", "Managed worktree state failed.");
      } catch {
        return failure("WORKTREE_STATE_FAILED", "Managed worktree state failed.");
      }
    },

    recordPublished(worktreeKey: string, head: string, verifiedAt: number): Result<void> {
      try {
        const changed = database
          .query(
            `UPDATE local_run_worktrees
             SET current_head = ?, published_commit = ?, published_verified_at = ?, updated_at = ?
             WHERE worktree_key = ? AND state IN ('READY', 'RETAINED')`,
          )
          .run(head, head, verifiedAt, clock(), worktreeKey);
        return changed.changes === 1
          ? { ok: true, value: undefined }
          : failure("WORKTREE_STATE_CONFLICT", "Managed worktree state changed.");
      } catch {
        return failure("WORKTREE_STATE_FAILED", "Managed worktree state failed.");
      }
    },

    rebindBranch(
      worktreeKey: string,
      expectedBranchRef: string,
      branchRef: string,
    ): Result<LocalWorktreeRecord> {
      try {
        const changed = database
          .query(
            `UPDATE local_run_worktrees SET branch_ref = ?, updated_at = ?
             WHERE worktree_key = ? AND branch_ref = ? AND state IN ('READY', 'RETAINED')`,
          )
          .run(branchRef, clock(), worktreeKey, expectedBranchRef);
        if (changed.changes !== 1) {
          return failure("WORKTREE_STATE_CONFLICT", "Managed worktree state changed.");
        }
        const row = selectByKey.get(worktreeKey);
        return row
          ? { ok: true, value: worktreeRecord(row) }
          : failure("WORKTREE_STATE_FAILED", "Managed worktree state failed.");
      } catch {
        return failure("WORKTREE_STATE_FAILED", "Managed worktree state failed.");
      }
    },

    retain(
      worktreeKey: string,
      input: Readonly<{
        head: string;
        reason: CleanupRetentionReason;
        digest: string;
        summaryJson: string;
      }>,
    ): Result<LocalWorktreeRecord> {
      const current = selectByKey.get(worktreeKey);
      if (!current || current.state === "REMOVED" || current.state === "DISCARDED") {
        return failure("WORKTREE_STATE_CONFLICT", "Managed worktree state changed.");
      }
      const retainedWorkId = current.retained_work_id ?? id("retained_work");
      try {
        const changed = database
          .query(
            `UPDATE local_run_worktrees
             SET state = 'RETAINED', current_head = ?, retained_work_id = ?, retained_reason = ?,
                 observation_revision = observation_revision + 1, observation_digest = ?,
                 summary_json = ?, updated_at = ?
             WHERE worktree_key = ? AND observation_revision = ?
               AND state IN ('READY', 'RETAINED')`,
          )
          .run(
            input.head,
            retainedWorkId,
            input.reason,
            input.digest,
            input.summaryJson,
            clock(),
            worktreeKey,
            current.observation_revision,
          );
        if (changed.changes !== 1) {
          return failure("WORKTREE_STATE_CONFLICT", "Managed worktree state changed.");
        }
        const row = selectByKey.get(worktreeKey);
        return row
          ? { ok: true, value: worktreeRecord(row) }
          : failure("WORKTREE_STATE_FAILED", "Managed worktree state failed.");
      } catch {
        return failure("WORKTREE_STATE_FAILED", "Managed worktree state failed.");
      }
    },

    markRemoved(worktreeKey: string, head: string): Result<void> {
      try {
        const changed = database
          .query(
            `UPDATE local_run_worktrees SET state = 'REMOVED', current_head = ?, updated_at = ?
             WHERE worktree_key = ? AND state IN ('READY', 'RETAINED')`,
          )
          .run(head, clock(), worktreeKey);
        return changed.changes === 1
          ? { ok: true, value: undefined }
          : failure("WORKTREE_STATE_CONFLICT", "Managed worktree state changed.");
      } catch {
        return failure("WORKTREE_STATE_FAILED", "Managed worktree state failed.");
      }
    },

    markDiscarded(worktreeKey: string, head: string): Result<void> {
      try {
        const changed = database
          .query(
            `UPDATE local_run_worktrees SET state = 'DISCARDED', current_head = ?, updated_at = ?
             WHERE worktree_key = ? AND state = 'RETAINED'`,
          )
          .run(head, clock(), worktreeKey);
        return changed.changes === 1
          ? { ok: true, value: undefined }
          : failure("WORKTREE_STATE_CONFLICT", "Managed worktree state changed.");
      } catch {
        return failure("WORKTREE_STATE_FAILED", "Managed worktree state failed.");
      }
    },
  };
}
