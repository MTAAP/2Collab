import type { Database } from "bun:sqlite";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  AttemptPublishAuthorization,
  CommittedCleanupAuthorization,
  RetainedWorkDiscardAuthorization,
  RetainedWorkPublishAuthorization,
  WorktreeAuthorizationClaims,
} from "../../shared/contracts/commands.ts";
import type { Result } from "../../shared/contracts/result.ts";
import { GitRefSchema } from "../../shared/contracts/runners.ts";
import type {
  CleanupDisposition,
  CleanupRetentionReason,
  DiscardObservation,
  DiscardReceipt,
  RetainedLocalWorkProjection,
} from "../../shared/contracts/runs.ts";
import { createLocalWorktreeRegistry, type LocalWorktreeRecord } from "../process-state.ts";
import {
  headReachableFromRemote,
  mayRemove,
  observationDigest,
  observeWorktree,
  removeWorktree,
  type WorktreeObservation,
} from "./cleanup.ts";
import {
  createProcessGitCommandRunner,
  type GitCommandRunner,
  publishExactHead,
} from "./publish.ts";

export type { WorktreeAuthorizationClaims } from "../../shared/contracts/commands.ts";

const handleBrand: unique symbol = Symbol("COLLAB_WORKTREE_HANDLE");

export type WorktreeHandle = Readonly<{
  id: string;
  toJSON(): never;
  [handleBrand]: true;
}>;

export type WorktreeRequest = Readonly<{
  runId: string;
  expectedRunRevision: number;
  projectId: string;
  repositoryId: string;
  runnerId: string;
  ownerMemberId: string;
  repositoryRoot: string;
  baseCommit: string;
  branch: string;
  remoteName: string;
  remoteIdentity: string;
  remoteRef: string;
}>;

export type RunnerOwnerActor = Readonly<{
  kind: "RUNNER_OWNER";
  memberId: string;
  runnerId: string;
}>;

export interface WorktreeManager {
  createOrReuse(request: WorktreeRequest): Promise<Result<WorktreeHandle>>;
  publish(
    handle: WorktreeHandle,
    authorization: AttemptPublishAuthorization | RetainedWorkPublishAuthorization,
  ): Promise<Result<import("../../shared/contracts/runs.ts").PublishedGitReference>>;
  cleanup(
    handle: WorktreeHandle,
    authorization: CommittedCleanupAuthorization,
  ): Promise<Result<CleanupDisposition>>;
  previewDiscard(
    handle: WorktreeHandle,
    actor: RunnerOwnerActor,
  ): Promise<Result<DiscardObservation>>;
  discard(
    handle: WorktreeHandle,
    authorization: RetainedWorkDiscardAuthorization,
  ): Promise<Result<DiscardReceipt>>;
}

export type WorktreeManagerDependencies = Readonly<{
  database: Database;
  managedRoot: string;
  clock: () => number;
  id: (kind: "worktree" | "retained_work") => string;
  pinRun(
    input: Readonly<{
      runId: string;
      expectedRunRevision: number;
      runnerId: string;
      worktreeKey: string;
    }>,
  ): Promise<Result<Readonly<{ runRevision: number }>>>;
  authorizations: Readonly<{
    verify(token: string): Promise<Result<WorktreeAuthorizationClaims>>;
    consume(token: string, authorizationId: string): Promise<Result<void>>;
  }>;
  git?: GitCommandRunner;
}>;

const WorktreeRequestSchema = z
  .object({
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    expectedRunRevision: z.number().int().positive(),
    projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    repositoryId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    runnerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    ownerMemberId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    repositoryRoot: z.string().min(1).max(4_096),
    baseCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    branch: GitRefSchema,
    remoteName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    remoteIdentity: z.string().min(1).max(128),
    remoteRef: GitRefSchema,
  })
  .strict();

const repositoryLocks = new Map<string, Promise<void>>();

async function withRepositoryLock<T>(repository: string, operation: () => Promise<T>): Promise<T> {
  const previous = repositoryLocks.get(repository) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  repositoryLocks.set(repository, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (repositoryLocks.get(repository) === queued) repositoryLocks.delete(repository);
  }
}

function failure<T>(
  code: string,
  message: string,
  retry: "NEVER" | "REFRESH" = "NEVER",
): Result<T> {
  return { ok: false, error: { code, message, retry } };
}

function handle(worktreeKey: string): WorktreeHandle {
  const value = { id: worktreeKey } as WorktreeHandle;
  Object.defineProperties(value, {
    [handleBrand]: { value: true },
    toJSON: {
      value: () => {
        throw new Error("WORKTREE_HANDLE_NOT_SERIALIZABLE");
      },
    },
  });
  return Object.freeze(value);
}

function validHandle(value: WorktreeHandle): boolean {
  return Boolean(value && value[handleBrand] === true);
}

async function canonicalDirectory(path: string): Promise<string | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
    return await realpath(path);
  } catch {
    return null;
  }
}

function assignmentFor(request: WorktreeRequest, root: string, key: string, managedRoot: string) {
  return {
    runId: request.runId,
    worktreeKey: key,
    projectId: request.projectId,
    repositoryId: request.repositoryId,
    runnerId: request.runnerId,
    ownerMemberId: request.ownerMemberId,
    repositoryRoot: root,
    worktreePath: join(managedRoot, key),
    baseCommit: request.baseCommit,
    branchRef: request.branch,
    remoteName: request.remoteName,
    remoteIdentity: request.remoteIdentity,
    remoteRef: request.remoteRef,
  };
}

async function verifyWorktree(
  git: GitCommandRunner,
  record: LocalWorktreeRecord,
): Promise<Readonly<{ head: string }> | null> {
  const [head, branch] = await Promise.all([
    git.run(record.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]),
    git.run(record.worktreePath, ["symbolic-ref", "--short", "HEAD"]),
  ]);
  const value = head.stdout.trim();
  return head.exitCode === 0 &&
    branch.exitCode === 0 &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) &&
    branch.stdout.trim() === record.branchRef
    ? { head: value }
    : null;
}

function projection(
  record: LocalWorktreeRecord,
  observation: WorktreeObservation,
  reason: CleanupRetentionReason,
  now: number,
): RetainedLocalWorkProjection {
  if (!record.retainedWorkId || !record.observationDigest || record.observationRevision < 1) {
    throw new Error("WORKTREE_STATE_CORRUPT");
  }
  return {
    retainedWorkId: record.retainedWorkId,
    worktreeIdentity: record.worktreeKey,
    revision: record.observationRevision,
    observationDigest: record.observationDigest as never,
    expectedHead: observation.head as never,
    reason,
    branch: record.branchRef,
    observedAt: now as never,
    ageSeconds: Math.max(0, now - record.createdAt),
    diskUsageBytes: observation.diskUsageBytes,
    trackedChangeCount: observation.trackedChangeCount,
    untrackedFileCount: observation.untrackedFileCount,
    unpublishedCommitCount: observation.unpublishedCommitCount,
    changedPaths: observation.changedPaths as never,
    truncated: observation.truncated,
    publishState: observation.publishState,
  };
}

function summaryJson(observation: WorktreeObservation): string {
  return JSON.stringify({
    head: observation.head,
    branch: observation.branch,
    trackedClean: observation.trackedClean,
    untrackedClean: observation.untrackedClean,
    trackedChangeCount: observation.trackedChangeCount,
    untrackedFileCount: observation.untrackedFileCount,
    unpublishedCommitCount: observation.unpublishedCommitCount,
    changedPaths: observation.changedPaths,
    truncated: observation.truncated,
    publishState: observation.publishState,
    diskUsageBytes: observation.diskUsageBytes,
  });
}

export function createWorktreeManager(dependencies: WorktreeManagerDependencies): WorktreeManager {
  const git = dependencies.git ?? createProcessGitCommandRunner();
  const registry = createLocalWorktreeRegistry(dependencies.database, dependencies.clock, (kind) =>
    dependencies.id(kind),
  );

  async function observe(record: LocalWorktreeRecord): Promise<WorktreeObservation | null> {
    return observeWorktree({
      git,
      repositoryRoot: record.repositoryRoot,
      worktreePath: record.worktreePath,
      baseCommit: record.baseCommit,
      branch: record.branchRef,
      remoteName: record.remoteName,
      remoteIdentity: record.remoteIdentity,
      remoteRef: record.remoteRef,
    });
  }

  function retain(
    record: LocalWorktreeRecord,
    observation: WorktreeObservation,
    reason: CleanupRetentionReason,
  ): Result<CleanupDisposition> {
    const persisted = registry.retain(record.worktreeKey, {
      head: observation.head,
      reason,
      digest: observationDigest(observation),
      summaryJson: summaryJson(observation),
    });
    if (!persisted.ok) return persisted;
    return {
      ok: true,
      value: {
        kind: "RETAINED_LOCAL_WORK",
        ...projection(persisted.value, observation, reason, dependencies.clock()),
      },
    };
  }

  async function authorityClaims(token: string): Promise<Result<WorktreeAuthorizationClaims>> {
    const verified = await dependencies.authorizations.verify(token);
    if (!verified.ok) return verified;
    if (dependencies.clock() >= verified.value.expiresAt) {
      return failure(
        "WORKTREE_AUTHORIZATION_EXPIRED",
        "Worktree authorization expired.",
        "REFRESH",
      );
    }
    return verified;
  }

  return {
    async createOrReuse(rawRequest) {
      const parsed = WorktreeRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return failure("WORKTREE_REQUEST_INVALID", "Managed worktree request is invalid.");
      }
      const request = parsed.data;
      const [repositoryRoot, managedRoot] = await Promise.all([
        canonicalDirectory(request.repositoryRoot),
        canonicalDirectory(dependencies.managedRoot),
      ]);
      if (!repositoryRoot || !managedRoot || repositoryRoot !== request.repositoryRoot) {
        return failure("WORKTREE_MAPPING_INVALID", "Managed repository mapping is invalid.");
      }
      return withRepositoryLock(repositoryRoot, async () => {
        const existing = registry.inspectByRun(request.runId);
        let record: LocalWorktreeRecord;
        if (existing.ok) {
          const expected = assignmentFor(
            request,
            repositoryRoot,
            existing.value.worktreeKey,
            managedRoot,
          );
          const reservation = registry.reserve(expected);
          if (!reservation.ok) return reservation;
          record = reservation.value;
          if (
            record.state === "REMOVED" ||
            record.state === "DISCARDED" ||
            record.state === "RETAINED"
          ) {
            return failure("WORKTREE_STATE_CONFLICT", "Managed worktree cannot be reused.");
          }
        } else {
          const key = dependencies.id("worktree");
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(key)) {
            return failure("WORKTREE_ID_INVALID", "Managed worktree identity is invalid.");
          }
          const reservation = registry.reserve(
            assignmentFor(request, repositoryRoot, key, managedRoot),
          );
          if (!reservation.ok) return reservation;
          record = reservation.value;
        }

        if (record.state === "CREATING") {
          let verified = await verifyWorktree(git, record);
          if (!verified) {
            const base = await git.run(repositoryRoot, [
              "rev-parse",
              "--verify",
              `${record.baseCommit}^{commit}`,
            ]);
            if (base.exitCode !== 0 || base.stdout.trim() !== record.baseCommit) {
              return failure("WORKTREE_BASE_INVALID", "Exact worktree base commit is unavailable.");
            }
            const branch = await git.run(repositoryRoot, [
              "show-ref",
              "--hash",
              "--verify",
              `refs/heads/${record.branchRef}`,
            ]);
            if (branch.exitCode === 0 && branch.stdout.trim() !== record.baseCommit) {
              return failure(
                "WORKTREE_BRANCH_COLLISION",
                "Managed worktree branch already exists.",
              );
            }
            const args =
              branch.exitCode === 0
                ? ["worktree", "add", record.worktreePath, record.branchRef]
                : [
                    "worktree",
                    "add",
                    "--no-track",
                    "-b",
                    record.branchRef,
                    record.worktreePath,
                    record.baseCommit,
                  ];
            const created = await git.run(repositoryRoot, args);
            if (created.exitCode !== 0) {
              return failure("WORKTREE_CREATE_FAILED", "Managed worktree could not be created.");
            }
            verified = await verifyWorktree(git, record);
          }
          if (!verified || verified.head !== record.baseCommit) {
            return failure(
              "WORKTREE_RECONCILIATION_FAILED",
              "Managed worktree could not be reconciled.",
            );
          }
          const ready = registry.markReady(record.worktreeKey, verified.head);
          if (!ready.ok) return ready;
          record = ready.value;
        } else {
          const verified = await verifyWorktree(git, record);
          if (!verified) {
            return failure(
              "WORKTREE_RECONCILIATION_FAILED",
              "Managed worktree could not be reconciled.",
            );
          }
        }

        if (record.pinnedRunRevision === null) {
          const pinned = await dependencies.pinRun({
            runId: record.runId,
            expectedRunRevision: request.expectedRunRevision,
            runnerId: record.runnerId,
            worktreeKey: record.worktreeKey,
          });
          if (!pinned.ok) return pinned;
          const persisted = registry.markPinned(record.worktreeKey, pinned.value.runRevision);
          if (!persisted.ok) return persisted;
        }
        return { ok: true, value: handle(record.worktreeKey) };
      });
    },

    async publish(worktreeHandle, authorization) {
      if (!validHandle(worktreeHandle)) {
        return failure("WORKTREE_HANDLE_INVALID", "Managed worktree handle is invalid.");
      }
      const record = registry.inspectByKey(worktreeHandle.id);
      if (!record.ok) return record;
      return withRepositoryLock(record.value.repositoryRoot, async () => {
        const current = registry.inspectByKey(worktreeHandle.id);
        if (!current.ok) return current;
        const local = current.value;
        const verified = await authorityClaims(authorization.token);
        if (!verified.ok) return verified;
        const claims = verified.value;
        if (
          claims.kind !== authorization.kind ||
          (claims.kind !== "ATTEMPT_PUBLISH" && claims.kind !== "RETAINED_WORK_PUBLISH") ||
          claims.runnerId !== local.runnerId ||
          claims.runId !== local.runId ||
          claims.worktreeKey !== local.worktreeKey ||
          claims.remoteIdentity !== local.remoteIdentity ||
          claims.remoteRef !== local.remoteRef
        ) {
          return failure(
            "WORKTREE_AUTHORIZATION_MISMATCH",
            "Worktree authorization does not match.",
          );
        }
        if (claims.kind === "ATTEMPT_PUBLISH" && local.state !== "READY") {
          return failure(
            "WORKTREE_AUTHORIZATION_MISMATCH",
            "Worktree authorization does not match.",
          );
        }
        if (
          claims.kind === "RETAINED_WORK_PUBLISH" &&
          (local.state !== "RETAINED" ||
            claims.ownerMemberId !== local.ownerMemberId ||
            claims.retainedWorkId !== local.retainedWorkId ||
            claims.observationRevision !== local.observationRevision ||
            claims.observationDigest !== local.observationDigest)
        ) {
          return failure(
            "WORKTREE_AUTHORIZATION_MISMATCH",
            "Worktree authorization does not match.",
          );
        }
        const beforeConsume = await observe(local);
        if (!beforeConsume) {
          return failure("WORKTREE_OBSERVATION_FAILED", "Managed worktree could not be inspected.");
        }
        if (
          beforeConsume.head !== claims.expectedHead ||
          !beforeConsume.trackedClean ||
          !beforeConsume.untrackedClean
        ) {
          return failure(
            "WORKTREE_NOT_PUBLISHABLE",
            "Managed worktree is not clean at authorized HEAD.",
          );
        }
        if (
          claims.kind === "RETAINED_WORK_PUBLISH" &&
          observationDigest(beforeConsume) !== claims.observationDigest
        ) {
          return failure(
            "WORKTREE_OBSERVATION_CHANGED",
            "Retained work observation changed.",
            "REFRESH",
          );
        }
        const consumed = await dependencies.authorizations.consume(
          authorization.token,
          claims.authorizationId,
        );
        if (!consumed.ok) return consumed;
        const beforePush = await observe(local);
        if (
          !beforePush ||
          beforePush.head !== beforeConsume.head ||
          observationDigest(beforePush) !== observationDigest(beforeConsume)
        ) {
          return failure("WORKTREE_HEAD_CHANGED", "Managed worktree HEAD changed.", "REFRESH");
        }
        const published = await publishExactHead({
          git,
          repositoryRoot: local.repositoryRoot,
          worktreePath: local.worktreePath,
          remoteName: local.remoteName,
          remoteIdentity: local.remoteIdentity,
          remoteRef: local.remoteRef,
          head: beforePush.head,
          clock: dependencies.clock,
        });
        if (!published) {
          return failure(
            "WORKTREE_PUBLISH_FAILED",
            "Managed worktree could not be published.",
            "REFRESH",
          );
        }
        const persisted = registry.recordPublished(
          local.worktreeKey,
          published.commitSha,
          published.verifiedAt,
        );
        return persisted.ok ? { ok: true, value: published } : persisted;
      });
    },

    async cleanup(worktreeHandle, authorization) {
      if (!validHandle(worktreeHandle)) {
        return failure("WORKTREE_HANDLE_INVALID", "Managed worktree handle is invalid.");
      }
      const found = registry.inspectByKey(worktreeHandle.id);
      if (!found.ok) return found;
      return withRepositoryLock(found.value.repositoryRoot, async () => {
        const current = registry.inspectByKey(worktreeHandle.id);
        if (!current.ok) return current;
        const record = current.value;
        const verified = await authorityClaims(authorization.token);
        const initial = await observe(record);
        if (!initial) {
          return failure("WORKTREE_OBSERVATION_FAILED", "Managed worktree could not be inspected.");
        }
        if (
          !verified.ok ||
          verified.value.kind !== "COMMITTED_CLEANUP" ||
          verified.value.runnerId !== record.runnerId ||
          verified.value.runId !== record.runId ||
          verified.value.worktreeKey !== record.worktreeKey
        ) {
          return retain(record, initial, "AUTHORITY_UNAVAILABLE");
        }
        const reachable = await headReachableFromRemote(git, record.worktreePath, initial);
        const decision = mayRemove({
          runTerminal: ["COMPLETED", "FAILED", "CANCELLED"].includes(verified.value.runState),
          activeAttempt: !verified.value.noActiveAttempt,
          expectedHead: verified.value.expectedHead,
          observation: initial,
          headReachableFromPublishedRef: reachable,
        });
        if (decision.kind === "RETAINED_LOCAL_WORK") {
          return retain(record, initial, decision.reason);
        }

        const beforeConsume = await observe(record);
        if (!beforeConsume) return retain(record, initial, "CLEANUP_FAILED");
        if (observationDigest(beforeConsume) !== observationDigest(initial)) {
          return retain(record, beforeConsume, "HEAD_CHANGED");
        }
        const consumed = await dependencies.authorizations.consume(
          authorization.token,
          verified.value.authorizationId,
        );
        if (!consumed.ok) return retain(record, beforeConsume, "AUTHORITY_UNAVAILABLE");
        const beforeRemoval = await observe(record);
        if (!beforeRemoval) return retain(record, beforeConsume, "CLEANUP_FAILED");
        if (observationDigest(beforeRemoval) !== observationDigest(beforeConsume)) {
          return retain(record, beforeRemoval, "HEAD_CHANGED");
        }
        const finalReachable = await headReachableFromRemote(
          git,
          record.worktreePath,
          beforeRemoval,
        );
        const finalDecision = mayRemove({
          runTerminal: true,
          activeAttempt: false,
          expectedHead: verified.value.expectedHead,
          observation: beforeRemoval,
          headReachableFromPublishedRef: finalReachable,
        });
        if (finalDecision.kind === "RETAINED_LOCAL_WORK") {
          return retain(record, beforeRemoval, finalDecision.reason);
        }
        const removal = await removeWorktree({
          git,
          repositoryRoot: record.repositoryRoot,
          worktreePath: record.worktreePath,
          branchRef: record.branchRef,
          expectedHead: beforeRemoval.head,
          force: false,
        });
        if (removal.kind !== "REMOVED") {
          if (removal.kind === "FAILED_UNCERTAIN") {
            return failure(
              "WORKTREE_CLEANUP_UNCERTAIN",
              "Managed worktree cleanup could not be reconciled.",
              "REFRESH",
            );
          }
          const rebound =
            removal.branchRef === record.branchRef
              ? { ok: true as const, value: record }
              : registry.rebindBranch(record.worktreeKey, record.branchRef, removal.branchRef);
          if (!rebound.ok) return rebound;
          const restoredObservation = await observe(rebound.value);
          return restoredObservation
            ? retain(rebound.value, restoredObservation, "CLEANUP_FAILED")
            : failure(
                "WORKTREE_CLEANUP_UNCERTAIN",
                "Managed worktree cleanup could not be reconciled.",
                "REFRESH",
              );
        }
        const stored = registry.markRemoved(record.worktreeKey, beforeRemoval.head);
        if (!stored.ok) return stored;
        if (beforeRemoval.remote.kind !== "AVAILABLE" || !beforeRemoval.remote.commit) {
          return failure("WORKTREE_STATE_FAILED", "Managed worktree state failed.");
        }
        return {
          ok: true,
          value: {
            kind: "REMOVED",
            worktreeIdentity: record.worktreeKey,
            head: beforeRemoval.head as never,
            publishedReference: {
              remoteIdentity: record.remoteIdentity,
              remoteRef: record.remoteRef,
              commitSha: beforeRemoval.remote.commit as never,
              verifiedAt: dependencies.clock() as never,
            },
            trackedClean: true,
            untrackedClean: true,
            removedAt: dependencies.clock() as never,
          },
        };
      });
    },

    async previewDiscard(worktreeHandle, actor) {
      if (!validHandle(worktreeHandle)) {
        return failure("WORKTREE_HANDLE_INVALID", "Managed worktree handle is invalid.");
      }
      const found = registry.inspectByKey(worktreeHandle.id);
      if (!found.ok) return found;
      return withRepositoryLock(found.value.repositoryRoot, async () => {
        const current = registry.inspectByKey(worktreeHandle.id);
        if (!current.ok) return current;
        const record = current.value;
        if (actor.runnerId !== record.runnerId || actor.memberId !== record.ownerMemberId) {
          return failure("WORKTREE_OWNER_REQUIRED", "Runner owner authorization is required.");
        }
        if (record.state !== "RETAINED" || !record.retainedReason) {
          return failure("WORKTREE_NOT_RETAINED", "Managed worktree is not retained.");
        }
        const observation = await observe(record);
        if (!observation) {
          return failure("WORKTREE_OBSERVATION_FAILED", "Managed worktree could not be inspected.");
        }
        const reason =
          record.currentHead && record.currentHead !== observation.head
            ? "HEAD_CHANGED"
            : record.retainedReason;
        const persisted = registry.retain(record.worktreeKey, {
          head: observation.head,
          reason,
          digest: observationDigest(observation),
          summaryJson: summaryJson(observation),
        });
        if (!persisted.ok) return persisted;
        return {
          ok: true,
          value: {
            kind: "DISCARD_OBSERVATION",
            ...projection(persisted.value, observation, reason, dependencies.clock()),
          },
        };
      });
    },

    async discard(worktreeHandle, authorization) {
      if (!validHandle(worktreeHandle)) {
        return failure("WORKTREE_HANDLE_INVALID", "Managed worktree handle is invalid.");
      }
      const found = registry.inspectByKey(worktreeHandle.id);
      if (!found.ok) return found;
      return withRepositoryLock(found.value.repositoryRoot, async () => {
        const current = registry.inspectByKey(worktreeHandle.id);
        if (!current.ok) return current;
        const record = current.value;
        const verified = await authorityClaims(authorization.token);
        if (!verified.ok) return verified;
        const claims = verified.value;
        if (
          claims.kind !== "RETAINED_WORK_DISCARD" ||
          record.state !== "RETAINED" ||
          claims.runnerId !== record.runnerId ||
          claims.ownerMemberId !== record.ownerMemberId ||
          claims.runId !== record.runId ||
          claims.worktreeKey !== record.worktreeKey ||
          claims.retainedWorkId !== record.retainedWorkId ||
          claims.observationRevision !== record.observationRevision ||
          claims.observationDigest !== record.observationDigest ||
          claims.remoteIdentity !== record.remoteIdentity ||
          claims.remoteRef !== record.remoteRef
        ) {
          return failure(
            "WORKTREE_AUTHORIZATION_MISMATCH",
            "Worktree authorization does not match.",
          );
        }
        const beforeConsume = await observe(record);
        if (
          !beforeConsume ||
          beforeConsume.head !== claims.expectedHead ||
          observationDigest(beforeConsume) !== claims.observationDigest
        ) {
          if (beforeConsume) retain(record, beforeConsume, "HEAD_CHANGED");
          return failure(
            "WORKTREE_OBSERVATION_CHANGED",
            "Retained work observation changed.",
            "REFRESH",
          );
        }
        const consumed = await dependencies.authorizations.consume(
          authorization.token,
          claims.authorizationId,
        );
        if (!consumed.ok) return consumed;
        const beforeRemoval = await observe(record);
        if (
          !beforeRemoval ||
          beforeRemoval.head !== claims.expectedHead ||
          observationDigest(beforeRemoval) !== claims.observationDigest
        ) {
          if (beforeRemoval) retain(record, beforeRemoval, "HEAD_CHANGED");
          return failure(
            "WORKTREE_OBSERVATION_CHANGED",
            "Retained work observation changed.",
            "REFRESH",
          );
        }
        const removal = await removeWorktree({
          git,
          repositoryRoot: record.repositoryRoot,
          worktreePath: record.worktreePath,
          branchRef: record.branchRef,
          expectedHead: beforeRemoval.head,
          force: true,
        });
        if (removal.kind !== "REMOVED") {
          if (removal.kind === "FAILED_RETAINED") {
            const rebound =
              removal.branchRef === record.branchRef
                ? { ok: true as const, value: record }
                : registry.rebindBranch(record.worktreeKey, record.branchRef, removal.branchRef);
            if (rebound.ok) {
              const restoredObservation = await observe(rebound.value);
              if (restoredObservation) retain(rebound.value, restoredObservation, "CLEANUP_FAILED");
            }
          }
          return failure(
            "WORKTREE_DISCARD_FAILED",
            "Retained work could not be discarded.",
            "REFRESH",
          );
        }
        const persisted = registry.markDiscarded(record.worktreeKey, beforeRemoval.head);
        if (!persisted.ok) return persisted;
        return {
          ok: true,
          value: {
            kind: "DISCARDED",
            retainedWorkId: claims.retainedWorkId,
            worktreeIdentity: record.worktreeKey,
            observationRevision: claims.observationRevision,
            observationDigest: claims.observationDigest as never,
            discardedHead: beforeRemoval.head as never,
            discardedAt: dependencies.clock() as never,
          },
        };
      });
    },
  };
}
