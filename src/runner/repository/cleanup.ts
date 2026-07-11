import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { RepositoryRelativePathSchema } from "../../shared/contracts/runners.ts";
import type { CleanupRetentionReason } from "../../shared/contracts/runs.ts";
import type { GitCommandRunner, RemoteObservation } from "./publish.ts";
import { observeRemoteReference, verifyConfiguredRemote } from "./publish.ts";

const MAX_CHANGED_PATHS = 128;
const MAX_DISK_ENTRIES = 100_000;

export type WorktreeObservation = Readonly<{
  head: string;
  branch: string;
  trackedClean: boolean;
  untrackedClean: boolean;
  trackedChangeCount: number;
  untrackedFileCount: number;
  unpublishedCommitCount: number;
  changedPaths: readonly string[];
  truncated: boolean;
  publishState: "UNPUBLISHED" | "PUBLISHED" | "UNKNOWN";
  remote: RemoteObservation;
  diskUsageBytes: number;
}>;

export type RemovalFacts = Readonly<{
  runTerminal: boolean;
  activeAttempt: boolean;
  expectedHead: string;
  observation: WorktreeObservation;
  headReachableFromPublishedRef: boolean;
}>;

export type RemovalDecision =
  | Readonly<{ kind: "REMOVE" }>
  | Readonly<{ kind: "RETAINED_LOCAL_WORK"; reason: CleanupRetentionReason }>;

export function mayRemove(facts: RemovalFacts): RemovalDecision {
  if (!facts.runTerminal) {
    return { kind: "RETAINED_LOCAL_WORK", reason: "RUN_NOT_TERMINAL" };
  }
  if (facts.activeAttempt) {
    return { kind: "RETAINED_LOCAL_WORK", reason: "ACTIVE_ATTEMPT" };
  }
  if (facts.observation.head !== facts.expectedHead) {
    return { kind: "RETAINED_LOCAL_WORK", reason: "HEAD_CHANGED" };
  }
  if (!facts.observation.trackedClean) {
    return { kind: "RETAINED_LOCAL_WORK", reason: "TRACKED_CHANGES" };
  }
  if (!facts.observation.untrackedClean) {
    return { kind: "RETAINED_LOCAL_WORK", reason: "UNTRACKED_FILES" };
  }
  if (facts.observation.remote.kind === "UNAVAILABLE") {
    return { kind: "RETAINED_LOCAL_WORK", reason: "REMOTE_UNAVAILABLE" };
  }
  if (!facts.headReachableFromPublishedRef) {
    return { kind: "RETAINED_LOCAL_WORK", reason: "UNPUBLISHED_HEAD" };
  }
  return { kind: "REMOVE" };
}

function splitNulls(output: string): string[] {
  return output.split("\0").filter((value) => value.length > 0);
}

function statusSummary(output: string): Readonly<{
  tracked: readonly string[];
  untracked: readonly string[];
}> {
  const records = splitNulls(output);
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 4 || record[2] !== " ") continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (status === "??") {
      untracked.push(path);
      continue;
    }
    if (status === "!!") continue;
    tracked.push(path);
    if (status.includes("R") || status.includes("C")) {
      const oldPath = records[index + 1];
      if (oldPath) {
        tracked.push(oldPath);
        index += 1;
      }
    }
  }
  return { tracked, untracked };
}

function safePaths(values: readonly string[]): readonly string[] {
  return [
    ...new Set(values.filter((value) => RepositoryRelativePathSchema.safeParse(value).success)),
  ]
    .sort()
    .slice(0, MAX_CHANGED_PATHS);
}

async function diskUsage(root: string): Promise<Readonly<{ bytes: number; truncated: boolean }>> {
  let bytes = 0;
  let entries = 0;
  let truncated = false;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    let children: Dirent[];
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return { bytes, truncated: true };
    }
    for (const child of children) {
      entries += 1;
      if (entries > MAX_DISK_ENTRIES) {
        truncated = true;
        pending.length = 0;
        break;
      }
      const path = join(directory, child.name);
      try {
        const metadata = await lstat(path);
        bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + metadata.size);
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) pending.push(path);
      } catch {
        truncated = true;
      }
    }
  }
  return { bytes, truncated };
}

async function countCommits(
  git: GitCommandRunner,
  worktreePath: string,
  range: string,
): Promise<number | null> {
  const result = await git.run(worktreePath, ["rev-list", "--count", range]);
  if (result.exitCode !== 0 || result.truncated) return null;
  const value = Number.parseInt(result.stdout.trim(), 10);
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 100_000) : null;
}

export async function observeWorktree(
  input: Readonly<{
    git: GitCommandRunner;
    repositoryRoot: string;
    worktreePath: string;
    baseCommit: string;
    branch: string;
    remoteName: string;
    remoteIdentity: string;
    remoteRef: string;
  }>,
): Promise<WorktreeObservation | null> {
  const [headResult, branchResult, statusResult, committedPathsResult, remoteValid, usage] =
    await Promise.all([
      input.git.run(input.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]),
      input.git.run(input.worktreePath, ["symbolic-ref", "--short", "HEAD"]),
      input.git.run(input.worktreePath, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=no",
      ]),
      input.git.run(input.worktreePath, ["diff", "--name-only", "-z", `${input.baseCommit}..HEAD`]),
      verifyConfiguredRemote(
        input.git,
        input.repositoryRoot,
        input.remoteName,
        input.remoteIdentity,
      ),
      diskUsage(input.worktreePath),
    ]);
  const head = headResult.stdout.trim();
  if (
    headResult.exitCode !== 0 ||
    branchResult.exitCode !== 0 ||
    statusResult.exitCode !== 0 ||
    committedPathsResult.exitCode !== 0 ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) ||
    branchResult.stdout.trim() !== input.branch
  ) {
    return null;
  }
  const current = statusSummary(statusResult.stdout);
  const committedPaths = splitNulls(committedPathsResult.stdout);
  const allPaths = [...current.tracked, ...current.untracked, ...committedPaths];
  const changedPaths = safePaths(allPaths);
  const truncated =
    statusResult.truncated ||
    committedPathsResult.truncated ||
    usage.truncated ||
    new Set(allPaths).size > changedPaths.length;
  let remote: RemoteObservation = { kind: "UNAVAILABLE" };
  if (remoteValid) {
    remote = await observeRemoteReference(
      input.git,
      input.repositoryRoot,
      input.remoteName,
      input.remoteRef,
    );
  }
  let unpublishedCommitCount = 0;
  let publishState: WorktreeObservation["publishState"] = "UNKNOWN";
  if (remote.kind === "AVAILABLE") {
    if (!remote.commit) {
      unpublishedCommitCount =
        (await countCommits(input.git, input.worktreePath, `${input.baseCommit}..${head}`)) ?? 0;
      publishState = "UNPUBLISHED";
    } else {
      const unpublished = await countCommits(
        input.git,
        input.worktreePath,
        `${remote.commit}..${head}`,
      );
      const reachable = await input.git.run(input.worktreePath, [
        "merge-base",
        "--is-ancestor",
        head,
        remote.commit,
      ]);
      unpublishedCommitCount = unpublished ?? 0;
      publishState = reachable.exitCode === 0 ? "PUBLISHED" : "UNPUBLISHED";
    }
  }
  return {
    head,
    branch: input.branch,
    trackedClean: current.tracked.length === 0,
    untrackedClean: current.untracked.length === 0,
    trackedChangeCount: Math.min(current.tracked.length, 100_000),
    untrackedFileCount: Math.min(current.untracked.length, 100_000),
    unpublishedCommitCount,
    changedPaths,
    truncated,
    publishState,
    remote,
    diskUsageBytes: usage.bytes,
  };
}

export function observationDigest(observation: WorktreeObservation): string {
  const stable = JSON.stringify({
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
    remoteCommit: observation.remote.kind === "AVAILABLE" ? observation.remote.commit : null,
    remoteAvailable: observation.remote.kind === "AVAILABLE",
  });
  return createHash("sha256").update(stable, "utf8").digest("hex");
}

export async function headReachableFromRemote(
  git: GitCommandRunner,
  worktreePath: string,
  observation: WorktreeObservation,
): Promise<boolean> {
  if (observation.remote.kind !== "AVAILABLE" || !observation.remote.commit) return false;
  const result = await git.run(worktreePath, [
    "merge-base",
    "--is-ancestor",
    observation.head,
    observation.remote.commit,
  ]);
  return result.exitCode === 0;
}

export type WorktreeRemovalOutcome =
  | Readonly<{ kind: "REMOVED" }>
  | Readonly<{ kind: "FAILED_RETAINED"; branchRef: string }>
  | Readonly<{ kind: "FAILED_UNCERTAIN" }>;

async function verifyRestoredWorktree(
  git: GitCommandRunner,
  worktreePath: string,
  branchRef: string,
  expectedHead: string,
): Promise<boolean> {
  const [head, branch] = await Promise.all([
    git.run(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]),
    git.run(worktreePath, ["symbolic-ref", "--short", "HEAD"]),
  ]);
  return (
    head.exitCode === 0 &&
    head.stdout.trim() === expectedHead &&
    branch.exitCode === 0 &&
    branch.stdout.trim() === branchRef
  );
}

export async function removeWorktree(
  input: Readonly<{
    git: GitCommandRunner;
    repositoryRoot: string;
    worktreePath: string;
    branchRef: string;
    expectedHead: string;
    force: boolean;
  }>,
): Promise<WorktreeRemovalOutcome> {
  const removeArgs = ["worktree", "remove"];
  if (input.force) removeArgs.push("--force");
  removeArgs.push(input.worktreePath);
  const removed = await input.git.run(input.repositoryRoot, removeArgs);
  if (removed.exitCode !== 0) {
    return (await verifyRestoredWorktree(
      input.git,
      input.worktreePath,
      input.branchRef,
      input.expectedHead,
    ))
      ? { kind: "FAILED_RETAINED", branchRef: input.branchRef }
      : { kind: "FAILED_UNCERTAIN" };
  }
  const deleted = await input.git.run(input.repositoryRoot, [
    "update-ref",
    "-d",
    `refs/heads/${input.branchRef}`,
    input.expectedHead,
  ]);
  if (deleted.exitCode === 0) return { kind: "REMOVED" };

  const originalBranch = await input.git.run(input.repositoryRoot, [
    "show-ref",
    "--hash",
    "--verify",
    `refs/heads/${input.branchRef}`,
  ]);
  let recoveryBranch = input.branchRef;
  if (originalBranch.exitCode !== 0 || originalBranch.stdout.trim() !== input.expectedHead) {
    const suffix = `-recovery-${input.expectedHead.slice(0, 12)}`;
    recoveryBranch = `${input.branchRef.slice(0, Math.max(1, 255 - suffix.length))}${suffix}`;
    const recoveryRef = `refs/heads/${recoveryBranch}`;
    const zero = "0".repeat(input.expectedHead.length);
    const created = await input.git.run(input.repositoryRoot, [
      "update-ref",
      recoveryRef,
      input.expectedHead,
      zero,
    ]);
    if (created.exitCode !== 0) {
      const existing = await input.git.run(input.repositoryRoot, [
        "show-ref",
        "--hash",
        "--verify",
        recoveryRef,
      ]);
      if (existing.exitCode !== 0 || existing.stdout.trim() !== input.expectedHead) {
        return { kind: "FAILED_UNCERTAIN" };
      }
    }
  }
  const restored = await input.git.run(input.repositoryRoot, [
    "worktree",
    "add",
    input.worktreePath,
    recoveryBranch,
  ]);
  if (
    restored.exitCode !== 0 ||
    !(await verifyRestoredWorktree(
      input.git,
      input.worktreePath,
      recoveryBranch,
      input.expectedHead,
    ))
  ) {
    return { kind: "FAILED_UNCERTAIN" };
  }
  return { kind: "FAILED_RETAINED", branchRef: recoveryBranch };
}
