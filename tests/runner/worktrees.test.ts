import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRunnerDatabase } from "../../src/runner/db/connection.ts";
import { migrateRunnerDatabase } from "../../src/runner/db/migrate.ts";
import {
  createProcessGitCommandRunner,
  remoteIdentityFromUrl,
} from "../../src/runner/repository/publish.ts";
import {
  createWorktreeManager,
  type WorktreeAuthorizationClaims,
} from "../../src/runner/repository/worktrees.ts";
import type { Result } from "../../src/shared/contracts/result.ts";

const directories: string[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function git(directory: string, ...args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", directory, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git failed: ${stderr}`);
  return stdout.trim();
}

async function createGitFixture() {
  const root = await mkdtemp(join(tmpdir(), "collab-worktrees-"));
  directories.push(root);
  const repositoryInput = join(root, "repository");
  const remote = join(root, "remote.git");
  const managedRootInput = join(root, "managed");
  await mkdir(repositoryInput);
  await mkdir(managedRootInput);
  const repository = await realpath(repositoryInput);
  const managedRoot = await realpath(managedRootInput);
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Collab Test");
  await git(repository, "config", "user.email", "collab@example.invalid");
  await writeFile(join(repository, "README.md"), "initial\n");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "initial");
  await git(root, "init", "--bare", remote);
  await git(repository, "remote", "add", "origin", remote);
  await git(repository, "push", "-u", "origin", "main");
  const baseCommit = await git(repository, "rev-parse", "HEAD");

  const database = openRunnerDatabase(join(root, "runner.db"));
  let nextId = 0;
  const claims = new Map<string, WorktreeAuthorizationClaims>();
  const consumed: string[] = [];
  const pinCalls: Array<Readonly<Record<string, unknown>>> = [];
  const manager = createWorktreeManager({
    database,
    managedRoot,
    clock: () => 1_000,
    id: (kind) => `${kind}_${++nextId}`,
    pinRun: async (input) => {
      pinCalls.push(input);
      return { ok: true, value: { runRevision: input.expectedRunRevision + 1 } };
    },
    authorizations: {
      verify: async (token): Promise<Result<WorktreeAuthorizationClaims>> => {
        const value = claims.get(token);
        return value
          ? { ok: true, value }
          : {
              ok: false,
              error: {
                code: "WORKTREE_AUTHORITY_UNAVAILABLE",
                message: "Worktree authority is unavailable.",
                retry: "REFRESH",
              },
            };
      },
      consume: async (token) => {
        consumed.push(token);
        return { ok: true, value: undefined };
      },
    },
  });
  const request = (runId: string) => ({
    runId,
    expectedRunRevision: 1,
    projectId: "project_1",
    repositoryId: "repository_1",
    runnerId: "runner_1",
    ownerMemberId: "owner_1",
    repositoryRoot: repository,
    baseCommit,
    branch: `collab/${runId}`,
    remoteName: "origin",
    remoteIdentity: remoteIdentityFromUrl(remote),
    remoteRef: `refs/heads/collab/${runId}`,
  });
  return {
    root,
    repository,
    remote,
    managedRoot,
    baseCommit,
    database,
    manager,
    claims,
    consumed,
    pinCalls,
    request,
    owner: () => ({ kind: "RUNNER_OWNER" as const, memberId: "owner_1", runnerId: "runner_1" }),
  };
}

test("one run reuses one worktree and dirty work is retained", async () => {
  const f = await createGitFixture();
  const first = await f.manager.createOrReuse(f.request("run_1"));
  expect(first).toMatchObject({ ok: true });
  if (!first.ok) throw new Error("expected worktree");
  const resumed = await f.manager.createOrReuse(f.request("run_1"));
  const separate = await f.manager.createOrReuse(f.request("run_2"));
  expect(resumed).toMatchObject({ ok: true, value: { id: first.value.id } });
  expect(separate).toMatchObject({ ok: true });
  if (!separate.ok) throw new Error("expected separate worktree");
  expect(separate.value.id).not.toBe(first.value.id);
  expect(() => JSON.stringify(first.value)).toThrow("WORKTREE_HANDLE_NOT_SERIALIZABLE");

  const worktreePath = f.database
    .query<{ worktree_path: string }, [string]>(
      "SELECT worktree_path FROM local_run_worktrees WHERE worktree_key = ?",
    )
    .get(first.value.id)?.worktree_path;
  if (!worktreePath) throw new Error("missing local worktree path");
  await writeFile(join(worktreePath, "retained.txt"), "local\n");
  f.claims.set("cleanup_1", {
    kind: "COMMITTED_CLEANUP",
    authorizationId: "authorization_1",
    runnerId: "runner_1",
    runId: "run_1",
    worktreeKey: first.value.id,
    expectedHead: f.request("run_1").baseCommit,
    runState: "COMPLETED",
    noActiveAttempt: true,
    expiresAt: 2_000,
  });
  const cleanup = await f.manager.cleanup(first.value, {
    kind: "COMMITTED_CLEANUP",
    token: "cleanup_1",
  });
  expect(cleanup).toMatchObject({
    ok: true,
    value: { kind: "RETAINED_LOCAL_WORK", reason: "UNTRACKED_FILES" },
  });
  expect(f.consumed).toEqual([]);
  f.database.close();
});

test("creation resolves an exact full commit and pins only after the worktree exists", async () => {
  const f = await createGitFixture();
  const abbreviated = f.baseCommit.slice(0, 12);
  expect(
    await f.manager.createOrReuse({ ...f.request("run_short"), baseCommit: abbreviated }),
  ).toMatchObject({
    ok: false,
    error: { code: "WORKTREE_REQUEST_INVALID" },
  });
  expect(
    await f.manager.createOrReuse({ ...f.request("run_missing"), baseCommit: "f".repeat(40) }),
  ).toMatchObject({ ok: false, error: { code: "WORKTREE_BASE_INVALID" } });

  const created = await f.manager.createOrReuse(f.request("run_exact"));
  expect(created).toMatchObject({ ok: true });
  expect(f.pinCalls).toHaveLength(1);
  const local = f.database
    .query<{ worktree_path: string; pinned_run_revision: number }, [string]>(
      "SELECT worktree_path, pinned_run_revision FROM local_run_worktrees WHERE run_id = ?",
    )
    .get("run_exact");
  expect(local?.pinned_run_revision).toBe(2);
  expect(local && (await git(local.worktree_path, "rev-parse", "HEAD"))).toBe(f.baseCommit);
  f.database.close();
});

test("creation reconciles a crash after git creation and retries a failed pin CAS", async () => {
  const f = await createGitFixture();
  const request = f.request("run_reconcile");
  const worktreeKey = "worktree_reconcile";
  const worktreePath = join(f.managedRoot, worktreeKey);
  f.database
    .query(
      `INSERT INTO local_run_worktrees(
         run_id, worktree_key, project_id, repository_id, runner_id, owner_member_id,
         repository_root, worktree_path, base_commit, branch_ref, remote_name,
         remote_identity, remote_ref, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATING', 900, 900)`,
    )
    .run(
      request.runId,
      worktreeKey,
      request.projectId,
      request.repositoryId,
      request.runnerId,
      request.ownerMemberId,
      request.repositoryRoot,
      worktreePath,
      request.baseCommit,
      request.branch,
      request.remoteName,
      request.remoteIdentity,
      request.remoteRef,
    );
  await git(
    f.repository,
    "worktree",
    "add",
    "--no-track",
    "-b",
    request.branch,
    worktreePath,
    request.baseCommit,
  );
  expect(await f.manager.createOrReuse(request)).toMatchObject({
    ok: true,
    value: { id: worktreeKey },
  });

  const branchOnlyRequest = f.request("run_branch_only");
  const branchOnlyKey = "worktree_branch_only";
  const branchOnlyPath = join(f.managedRoot, branchOnlyKey);
  f.database
    .query(
      `INSERT INTO local_run_worktrees(
         run_id, worktree_key, project_id, repository_id, runner_id, owner_member_id,
         repository_root, worktree_path, base_commit, branch_ref, remote_name,
         remote_identity, remote_ref, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATING', 900, 900)`,
    )
    .run(
      branchOnlyRequest.runId,
      branchOnlyKey,
      branchOnlyRequest.projectId,
      branchOnlyRequest.repositoryId,
      branchOnlyRequest.runnerId,
      branchOnlyRequest.ownerMemberId,
      branchOnlyRequest.repositoryRoot,
      branchOnlyPath,
      branchOnlyRequest.baseCommit,
      branchOnlyRequest.branch,
      branchOnlyRequest.remoteName,
      branchOnlyRequest.remoteIdentity,
      branchOnlyRequest.remoteRef,
    );
  await git(f.repository, "branch", branchOnlyRequest.branch, branchOnlyRequest.baseCommit);
  expect(await f.manager.createOrReuse(branchOnlyRequest)).toMatchObject({
    ok: true,
    value: { id: branchOnlyKey },
  });
  expect(await git(branchOnlyPath, "rev-parse", "HEAD")).toBe(branchOnlyRequest.baseCommit);

  let pins = 0;
  const manager = createWorktreeManager({
    database: f.database,
    managedRoot: f.managedRoot,
    clock: () => 1_000,
    id: (kind) => `${kind}_pin_retry`,
    pinRun: async (input) => {
      pins += 1;
      return pins === 1
        ? {
            ok: false,
            error: {
              code: "RUN_REVISION_CONFLICT",
              message: "Agent Run revision changed.",
              retry: "REFRESH",
            },
          }
        : { ok: true, value: { runRevision: input.expectedRunRevision + 1 } };
    },
    authorizations: {
      verify: async () => ({
        ok: false,
        error: { code: "NO_AUTH", message: "No authority.", retry: "NEVER" },
      }),
      consume: async () => ({ ok: true, value: undefined }),
    },
  });
  const pinRequest = f.request("run_pin_retry");
  expect(await manager.createOrReuse(pinRequest)).toMatchObject({
    ok: false,
    error: { code: "RUN_REVISION_CONFLICT" },
  });
  expect(
    f.database
      .query<{ state: string; pinned_run_revision: number | null }, [string]>(
        "SELECT state, pinned_run_revision FROM local_run_worktrees WHERE run_id = ?",
      )
      .get("run_pin_retry"),
  ).toEqual({ state: "READY", pinned_run_revision: null });
  expect(await manager.createOrReuse({ ...pinRequest, expectedRunRevision: 2 })).toMatchObject({
    ok: true,
  });
  expect(pins).toBe(2);
  f.database.close();
});

test("branch and managed-path collisions fail without sharing mutable state", async () => {
  const f = await createGitFixture();
  expect(await f.manager.createOrReuse(f.request("run_1"))).toMatchObject({ ok: true });
  expect(
    await f.manager.createOrReuse({
      ...f.request("run_2"),
      branch: "collab/run_1",
      remoteRef: "refs/heads/collab/run_1",
    }),
  ).toMatchObject({ ok: false, error: { code: "WORKTREE_ASSIGNMENT_CONFLICT" } });

  const duplicateKeyManager = createWorktreeManager({
    database: f.database,
    managedRoot: f.managedRoot,
    clock: () => 1_000,
    id: () => "worktree_1",
    pinRun: async (input) => ({
      ok: true,
      value: { runRevision: input.expectedRunRevision + 1 },
    }),
    authorizations: {
      verify: async () => ({
        ok: false,
        error: { code: "NO_AUTH", message: "No authority.", retry: "NEVER" },
      }),
      consume: async () => ({ ok: true, value: undefined }),
    },
  });
  expect(await duplicateKeyManager.createOrReuse(f.request("run_3"))).toMatchObject({
    ok: false,
    error: { code: "WORKTREE_ASSIGNMENT_CONFLICT" },
  });
  f.database.close();
});

test("attempt publication pushes and observes the exact authorized HEAD", async () => {
  const f = await createGitFixture();
  const created = await f.manager.createOrReuse(f.request("run_publish"));
  if (!created.ok) throw new Error("expected worktree");
  const worktreePath = f.database
    .query<{ worktree_path: string }, [string]>(
      "SELECT worktree_path FROM local_run_worktrees WHERE worktree_key = ?",
    )
    .get(created.value.id)?.worktree_path;
  if (!worktreePath) throw new Error("missing worktree");
  await writeFile(join(worktreePath, "published.txt"), "published\n");
  await git(worktreePath, "add", "published.txt");
  await git(worktreePath, "commit", "-m", "publish exact head");
  const head = await git(worktreePath, "rev-parse", "HEAD");
  f.claims.set("attempt_publish_1", {
    kind: "ATTEMPT_PUBLISH",
    authorizationId: "authorization_publish_1",
    runnerId: "runner_1",
    runId: "run_publish",
    worktreeKey: created.value.id,
    expectedHead: head,
    attemptId: "attempt_1",
    sessionId: "session_1",
    sessionFence: 1,
    remoteIdentity: f.request("run_publish").remoteIdentity,
    remoteRef: f.request("run_publish").remoteRef,
    expiresAt: 2_000,
  });

  expect(
    await f.manager.publish(created.value, {
      kind: "ATTEMPT_PUBLISH",
      token: "attempt_publish_1",
    }),
  ).toEqual({
    ok: true,
    value: {
      remoteIdentity: f.request("run_publish").remoteIdentity,
      remoteRef: f.request("run_publish").remoteRef,
      commitSha: head,
      verifiedAt: 1_000,
    },
  });
  expect(await git(f.repository, "ls-remote", "origin", f.request("run_publish").remoteRef)).toBe(
    `${head}\t${f.request("run_publish").remoteRef}`,
  );
  expect(f.consumed).toEqual(["attempt_publish_1"]);
  f.database.close();
});

test("clean remotely published work removes automatically while ignored files are disposable", async () => {
  const f = await createGitFixture();
  const request = f.request("run_cleanup");
  const created = await f.manager.createOrReuse(request);
  if (!created.ok) throw new Error("expected worktree");
  const worktreePath = f.database
    .query<{ worktree_path: string }, [string]>(
      "SELECT worktree_path FROM local_run_worktrees WHERE worktree_key = ?",
    )
    .get(created.value.id)?.worktree_path;
  if (!worktreePath) throw new Error("missing worktree");
  await writeFile(join(worktreePath, "published.txt"), "published\n");
  await git(worktreePath, "add", "published.txt");
  await git(worktreePath, "commit", "-m", "publish for cleanup");
  const head = await git(worktreePath, "rev-parse", "HEAD");
  f.claims.set("publish_cleanup", {
    kind: "ATTEMPT_PUBLISH",
    authorizationId: "authorization_publish_cleanup",
    runnerId: "runner_1",
    runId: request.runId,
    worktreeKey: created.value.id,
    expectedHead: head,
    attemptId: "attempt_cleanup",
    sessionId: "session_cleanup",
    sessionFence: 1,
    remoteIdentity: request.remoteIdentity,
    remoteRef: request.remoteRef,
    expiresAt: 2_000,
  });
  expect(
    await f.manager.publish(created.value, {
      kind: "ATTEMPT_PUBLISH",
      token: "publish_cleanup",
    }),
  ).toMatchObject({ ok: true });
  await writeFile(join(f.repository, ".git", "info", "exclude"), "ignored.log\n");
  await writeFile(join(worktreePath, "ignored.log"), "disposable\n");
  f.claims.set("cleanup_published", {
    kind: "COMMITTED_CLEANUP",
    authorizationId: "authorization_cleanup",
    runnerId: "runner_1",
    runId: request.runId,
    worktreeKey: created.value.id,
    expectedHead: head,
    runState: "COMPLETED",
    noActiveAttempt: true,
    expiresAt: 2_000,
  });
  expect(
    await f.manager.cleanup(created.value, {
      kind: "COMMITTED_CLEANUP",
      token: "cleanup_published",
    }),
  ).toMatchObject({
    ok: true,
    value: {
      kind: "REMOVED",
      head,
      trackedClean: true,
      untrackedClean: true,
      publishedReference: { commitSha: head, remoteRef: request.remoteRef },
    },
  });
  await expect(lstat(worktreePath)).rejects.toThrow();
  expect(
    f.database
      .query<{ state: string }, [string]>(
        "SELECT state FROM local_run_worktrees WHERE worktree_key = ?",
      )
      .get(created.value.id)?.state,
  ).toBe("REMOVED");
  f.database.close();
});

test("cleanup retains tracked, untracked, unpublished, remote-unavailable, and unavailable-authority work", async () => {
  const tracked = await createGitFixture();
  const trackedCreated = await tracked.manager.createOrReuse(tracked.request("run_tracked"));
  if (!trackedCreated.ok) throw new Error("expected worktree");
  const trackedPath = tracked.database
    .query<{ worktree_path: string }, [string]>(
      "SELECT worktree_path FROM local_run_worktrees WHERE worktree_key = ?",
    )
    .get(trackedCreated.value.id)?.worktree_path;
  if (!trackedPath) throw new Error("missing worktree");
  await writeFile(join(trackedPath, "README.md"), "changed\n");
  tracked.claims.set("cleanup_tracked", {
    kind: "COMMITTED_CLEANUP",
    authorizationId: "auth_tracked",
    runnerId: "runner_1",
    runId: "run_tracked",
    worktreeKey: trackedCreated.value.id,
    expectedHead: tracked.baseCommit,
    runState: "COMPLETED",
    noActiveAttempt: true,
    expiresAt: 2_000,
  });
  expect(
    await tracked.manager.cleanup(trackedCreated.value, {
      kind: "COMMITTED_CLEANUP",
      token: "cleanup_tracked",
    }),
  ).toMatchObject({ ok: true, value: { reason: "TRACKED_CHANGES" } });
  tracked.database.close();

  const unpublished = await createGitFixture();
  const unpublishedCreated = await unpublished.manager.createOrReuse(
    unpublished.request("run_unpublished"),
  );
  if (!unpublishedCreated.ok) throw new Error("expected worktree");
  const unpublishedPath = unpublished.database
    .query<{ worktree_path: string }, [string]>(
      "SELECT worktree_path FROM local_run_worktrees WHERE worktree_key = ?",
    )
    .get(unpublishedCreated.value.id)?.worktree_path;
  if (!unpublishedPath) throw new Error("missing worktree");
  await writeFile(join(unpublishedPath, "local.txt"), "local commit\n");
  await git(unpublishedPath, "add", "local.txt");
  await git(unpublishedPath, "commit", "-m", "local only");
  const unpublishedHead = await git(unpublishedPath, "rev-parse", "HEAD");
  unpublished.claims.set("cleanup_unpublished", {
    kind: "COMMITTED_CLEANUP",
    authorizationId: "auth_unpublished",
    runnerId: "runner_1",
    runId: "run_unpublished",
    worktreeKey: unpublishedCreated.value.id,
    expectedHead: unpublishedHead,
    runState: "COMPLETED",
    noActiveAttempt: true,
    expiresAt: 2_000,
  });
  expect(
    await unpublished.manager.cleanup(unpublishedCreated.value, {
      kind: "COMMITTED_CLEANUP",
      token: "cleanup_unpublished",
    }),
  ).toMatchObject({
    ok: true,
    value: { reason: "UNPUBLISHED_HEAD", unpublishedCommitCount: 1 },
  });
  unpublished.database.close();

  const remoteUnavailable = await createGitFixture();
  const remoteCreated = await remoteUnavailable.manager.createOrReuse(
    remoteUnavailable.request("run_remote"),
  );
  if (!remoteCreated.ok) throw new Error("expected worktree");
  remoteUnavailable.claims.set("cleanup_remote", {
    kind: "COMMITTED_CLEANUP",
    authorizationId: "auth_remote",
    runnerId: "runner_1",
    runId: "run_remote",
    worktreeKey: remoteCreated.value.id,
    expectedHead: remoteUnavailable.baseCommit,
    runState: "COMPLETED",
    noActiveAttempt: true,
    expiresAt: 2_000,
  });
  await rename(remoteUnavailable.remote, `${remoteUnavailable.remote}.offline`);
  expect(
    await remoteUnavailable.manager.cleanup(remoteCreated.value, {
      kind: "COMMITTED_CLEANUP",
      token: "cleanup_remote",
    }),
  ).toMatchObject({ ok: true, value: { reason: "REMOTE_UNAVAILABLE" } });
  remoteUnavailable.database.close();

  const unavailableAuthority = await createGitFixture();
  const unavailableCreated = await unavailableAuthority.manager.createOrReuse(
    unavailableAuthority.request("run_no_auth"),
  );
  if (!unavailableCreated.ok) throw new Error("expected worktree");
  expect(
    await unavailableAuthority.manager.cleanup(unavailableCreated.value, {
      kind: "COMMITTED_CLEANUP",
      token: "missing_authority",
    }),
  ).toMatchObject({ ok: true, value: { reason: "AUTHORITY_UNAVAILABLE" } });
  unavailableAuthority.database.close();
});

test("only a separately authorized runner owner can discard the exact retained observation", async () => {
  const f = await createGitFixture();
  const processGit = createProcessGitCommandRunner();
  const gitCalls: readonly string[][] = [];
  const calls = gitCalls as string[][];
  const manager = createWorktreeManager({
    database: f.database,
    managedRoot: f.managedRoot,
    clock: () => 1_000,
    id: (kind) => `${kind}_discard`,
    pinRun: async (input) => ({
      ok: true,
      value: { runRevision: input.expectedRunRevision + 1 },
    }),
    authorizations: {
      verify: async (token) => {
        const value = f.claims.get(token);
        return value
          ? { ok: true, value }
          : {
              ok: false,
              error: { code: "NO_AUTH", message: "No authority.", retry: "NEVER" },
            };
      },
      consume: async (token) => {
        f.consumed.push(token);
        return { ok: true, value: undefined };
      },
    },
    git: {
      async run(directory, args) {
        calls.push([...args]);
        return processGit.run(directory, args);
      },
    },
  });
  const request = f.request("run_discard");
  const created = await manager.createOrReuse(request);
  if (!created.ok) throw new Error("expected worktree");
  const worktreePath = f.database
    .query<{ worktree_path: string }, [string]>(
      "SELECT worktree_path FROM local_run_worktrees WHERE worktree_key = ?",
    )
    .get(created.value.id)?.worktree_path;
  if (!worktreePath) throw new Error("missing worktree");
  await writeFile(join(worktreePath, "discard.txt"), "discard me\n");
  f.claims.set("cleanup_for_discard", {
    kind: "COMMITTED_CLEANUP",
    authorizationId: "auth_cleanup_discard",
    runnerId: "runner_1",
    runId: request.runId,
    worktreeKey: created.value.id,
    expectedHead: request.baseCommit,
    runState: "FAILED",
    noActiveAttempt: true,
    expiresAt: 2_000,
  });
  expect(
    await manager.cleanup(created.value, {
      kind: "COMMITTED_CLEANUP",
      token: "cleanup_for_discard",
    }),
  ).toMatchObject({ ok: true, value: { reason: "UNTRACKED_FILES" } });
  expect(
    await manager.previewDiscard(created.value, {
      kind: "RUNNER_OWNER",
      memberId: "member_2",
      runnerId: "runner_1",
    }),
  ).toMatchObject({ ok: false, error: { code: "WORKTREE_OWNER_REQUIRED" } });
  const preview = await manager.previewDiscard(created.value, f.owner());
  expect(preview).toMatchObject({
    ok: true,
    value: {
      kind: "DISCARD_OBSERVATION",
      reason: "UNTRACKED_FILES",
      changedPaths: ["discard.txt"],
    },
  });
  if (!preview.ok) throw new Error("expected discard preview");
  f.claims.set("discard_stale", {
    kind: "RETAINED_WORK_DISCARD",
    authorizationId: "auth_discard_stale",
    runnerId: "runner_1",
    runId: request.runId,
    worktreeKey: created.value.id,
    expectedHead: preview.value.expectedHead,
    ownerMemberId: "owner_1",
    retainedWorkId: preview.value.retainedWorkId,
    observationRevision: preview.value.revision,
    observationDigest: preview.value.observationDigest,
    remoteIdentity: request.remoteIdentity,
    remoteRef: request.remoteRef,
    expiresAt: 2_000,
  });
  await writeFile(join(worktreePath, "after-preview.txt"), "changed after preview\n");
  expect(
    await manager.discard(created.value, {
      kind: "RETAINED_WORK_DISCARD",
      token: "discard_stale",
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "WORKTREE_OBSERVATION_CHANGED" },
  });
  const refreshed = await manager.previewDiscard(created.value, f.owner());
  if (!refreshed.ok) throw new Error("expected refreshed preview");
  f.claims.set("discard_exact", {
    kind: "RETAINED_WORK_DISCARD",
    authorizationId: "auth_discard_exact",
    runnerId: "runner_1",
    runId: request.runId,
    worktreeKey: created.value.id,
    expectedHead: refreshed.value.expectedHead,
    ownerMemberId: "owner_1",
    retainedWorkId: refreshed.value.retainedWorkId,
    observationRevision: refreshed.value.revision,
    observationDigest: refreshed.value.observationDigest,
    remoteIdentity: request.remoteIdentity,
    remoteRef: request.remoteRef,
    expiresAt: 2_000,
  });
  expect(
    await manager.discard(created.value, {
      kind: "RETAINED_WORK_DISCARD",
      token: "discard_exact",
    }),
  ).toMatchObject({
    ok: true,
    value: {
      kind: "DISCARDED",
      retainedWorkId: refreshed.value.retainedWorkId,
      observationRevision: refreshed.value.revision,
      observationDigest: refreshed.value.observationDigest,
    },
  });
  expect(calls.some((args) => args.join(" ").includes("worktree remove --force"))).toBe(true);
  expect(
    calls
      .filter((args) => args.includes("--force"))
      .every((args) => args[0] === "worktree" && args[1] === "remove"),
  ).toBe(true);
  expect(f.consumed).toContain("discard_exact");
  f.database.close();
});

test("retained publication uses owner authority without a live attempt and refuses dirty work", async () => {
  const f = await createGitFixture();
  const request = f.request("run_retained_publish");
  const created = await f.manager.createOrReuse(request);
  if (!created.ok) throw new Error("expected worktree");
  const worktreePath = f.database
    .query<{ worktree_path: string }, [string]>(
      "SELECT worktree_path FROM local_run_worktrees WHERE worktree_key = ?",
    )
    .get(created.value.id)?.worktree_path;
  if (!worktreePath) throw new Error("missing worktree");
  await writeFile(join(worktreePath, "retained-publish.txt"), "publish me\n");
  await git(worktreePath, "add", "retained-publish.txt");
  await git(worktreePath, "commit", "-m", "retained publish");
  const head = await git(worktreePath, "rev-parse", "HEAD");
  f.claims.set("cleanup_to_retain", {
    kind: "COMMITTED_CLEANUP",
    authorizationId: "cleanup_to_retain",
    runnerId: "runner_1",
    runId: request.runId,
    worktreeKey: created.value.id,
    expectedHead: head,
    runState: "COMPLETED",
    noActiveAttempt: true,
    expiresAt: 2_000,
  });
  const retained = await f.manager.cleanup(created.value, {
    kind: "COMMITTED_CLEANUP",
    token: "cleanup_to_retain",
  });
  expect(retained).toMatchObject({ ok: true, value: { reason: "UNPUBLISHED_HEAD" } });
  if (!retained.ok || retained.value.kind !== "RETAINED_LOCAL_WORK") {
    throw new Error("expected retained work");
  }
  f.claims.set("retained_publish", {
    kind: "RETAINED_WORK_PUBLISH",
    authorizationId: "authorization_retained_publish",
    runnerId: "runner_1",
    runId: request.runId,
    worktreeKey: created.value.id,
    expectedHead: head,
    ownerMemberId: "owner_1",
    retainedWorkId: retained.value.retainedWorkId,
    observationRevision: retained.value.revision,
    observationDigest: retained.value.observationDigest,
    remoteIdentity: request.remoteIdentity,
    remoteRef: request.remoteRef,
    expiresAt: 2_000,
  });
  expect(
    await f.manager.publish(created.value, {
      kind: "RETAINED_WORK_PUBLISH",
      token: "retained_publish",
    }),
  ).toMatchObject({ ok: true, value: { commitSha: head } });

  const dirtyRequest = f.request("run_dirty_publish");
  const dirty = await f.manager.createOrReuse(dirtyRequest);
  if (!dirty.ok) throw new Error("expected dirty worktree");
  const dirtyPath = f.database
    .query<{ worktree_path: string }, [string]>(
      "SELECT worktree_path FROM local_run_worktrees WHERE worktree_key = ?",
    )
    .get(dirty.value.id)?.worktree_path;
  if (!dirtyPath) throw new Error("missing dirty worktree");
  await writeFile(join(dirtyPath, "dirty.txt"), "dirty\n");
  f.claims.set("dirty_publish", {
    kind: "ATTEMPT_PUBLISH",
    authorizationId: "authorization_dirty_publish",
    runnerId: "runner_1",
    runId: dirtyRequest.runId,
    worktreeKey: dirty.value.id,
    expectedHead: dirtyRequest.baseCommit,
    attemptId: "attempt_dirty",
    sessionId: "session_dirty",
    sessionFence: 1,
    remoteIdentity: dirtyRequest.remoteIdentity,
    remoteRef: dirtyRequest.remoteRef,
    expiresAt: 2_000,
  });
  expect(
    await f.manager.publish(dirty.value, {
      kind: "ATTEMPT_PUBLISH",
      token: "dirty_publish",
    }),
  ).toMatchObject({ ok: false, error: { code: "WORKTREE_NOT_PUBLISHABLE" } });
  expect(f.consumed).not.toContain("dirty_publish");
  f.database.close();
});

test("cleanup fails toward retention for nonterminal runs, active attempts, and changed HEAD", async () => {
  for (const scenario of [
    {
      runId: "run_nonterminal",
      runState: "RUNNING" as const,
      noActiveAttempt: true,
      reason: "RUN_NOT_TERMINAL",
    },
    {
      runId: "run_active",
      runState: "COMPLETED" as const,
      noActiveAttempt: false,
      reason: "ACTIVE_ATTEMPT",
    },
  ]) {
    const f = await createGitFixture();
    const created = await f.manager.createOrReuse(f.request(scenario.runId));
    if (!created.ok) throw new Error("expected worktree");
    f.claims.set(`cleanup_${scenario.runId}`, {
      kind: "COMMITTED_CLEANUP",
      authorizationId: `auth_${scenario.runId}`,
      runnerId: "runner_1",
      runId: scenario.runId,
      worktreeKey: created.value.id,
      expectedHead: f.baseCommit,
      runState: scenario.runState,
      noActiveAttempt: scenario.noActiveAttempt,
      expiresAt: 2_000,
    });
    expect(
      await f.manager.cleanup(created.value, {
        kind: "COMMITTED_CLEANUP",
        token: `cleanup_${scenario.runId}`,
      }),
    ).toMatchObject({ ok: true, value: { reason: scenario.reason } });
    f.database.close();
  }

  const changed = await createGitFixture();
  const changedRequest = changed.request("run_head_changed");
  const changedCreated = await changed.manager.createOrReuse(changedRequest);
  if (!changedCreated.ok) throw new Error("expected worktree");
  const changedPath = changed.database
    .query<{ worktree_path: string }, [string]>(
      "SELECT worktree_path FROM local_run_worktrees WHERE worktree_key = ?",
    )
    .get(changedCreated.value.id)?.worktree_path;
  if (!changedPath) throw new Error("missing worktree");
  await writeFile(join(changedPath, "head-change.txt"), "change\n");
  await git(changedPath, "add", "head-change.txt");
  await git(changedPath, "commit", "-m", "change head");
  changed.claims.set("cleanup_old_head", {
    kind: "COMMITTED_CLEANUP",
    authorizationId: "auth_old_head",
    runnerId: "runner_1",
    runId: changedRequest.runId,
    worktreeKey: changedCreated.value.id,
    expectedHead: changedRequest.baseCommit,
    runState: "COMPLETED",
    noActiveAttempt: true,
    expiresAt: 2_000,
  });
  expect(
    await changed.manager.cleanup(changedCreated.value, {
      kind: "COMMITTED_CLEANUP",
      token: "cleanup_old_head",
    }),
  ).toMatchObject({ ok: true, value: { reason: "HEAD_CHANGED" } });
  changed.database.close();
});

test("cleanup rechecks after authorization consumption and retains concurrent HEAD or status changes", async () => {
  const f = await createGitFixture();
  const request = f.request("run_cleanup_race");
  const created = await f.manager.createOrReuse(request);
  if (!created.ok) throw new Error("expected worktree");
  const worktreePath = f.database
    .query<{ worktree_path: string }, [string]>(
      "SELECT worktree_path FROM local_run_worktrees WHERE worktree_key = ?",
    )
    .get(created.value.id)?.worktree_path;
  if (!worktreePath) throw new Error("missing worktree");
  f.claims.set("publish_race", {
    kind: "ATTEMPT_PUBLISH",
    authorizationId: "auth_publish_race",
    runnerId: "runner_1",
    runId: request.runId,
    worktreeKey: created.value.id,
    expectedHead: request.baseCommit,
    attemptId: "attempt_race",
    sessionId: "session_race",
    sessionFence: 1,
    remoteIdentity: request.remoteIdentity,
    remoteRef: request.remoteRef,
    expiresAt: 2_000,
  });
  expect(
    await f.manager.publish(created.value, { kind: "ATTEMPT_PUBLISH", token: "publish_race" }),
  ).toMatchObject({ ok: true });
  f.claims.set("cleanup_race", {
    kind: "COMMITTED_CLEANUP",
    authorizationId: "auth_cleanup_race",
    runnerId: "runner_1",
    runId: request.runId,
    worktreeKey: created.value.id,
    expectedHead: request.baseCommit,
    runState: "COMPLETED",
    noActiveAttempt: true,
    expiresAt: 2_000,
  });
  const racingManager = createWorktreeManager({
    database: f.database,
    managedRoot: f.managedRoot,
    clock: () => 1_000,
    id: (kind) => `${kind}_race`,
    pinRun: async () => ({
      ok: false,
      error: { code: "UNEXPECTED_PIN", message: "Unexpected pin.", retry: "NEVER" },
    }),
    authorizations: {
      verify: async (token) => {
        const value = f.claims.get(token);
        return value
          ? { ok: true, value }
          : {
              ok: false,
              error: { code: "NO_AUTH", message: "No authority.", retry: "NEVER" },
            };
      },
      consume: async (token) => {
        if (token === "cleanup_race") {
          await writeFile(join(worktreePath, "raced.txt"), "race\n");
          await git(worktreePath, "add", "raced.txt");
          await git(worktreePath, "commit", "-m", "race cleanup");
        }
        return { ok: true, value: undefined };
      },
    },
  });
  expect(
    await racingManager.cleanup(created.value, {
      kind: "COMMITTED_CLEANUP",
      token: "cleanup_race",
    }),
  ).toMatchObject({ ok: true, value: { reason: "HEAD_CHANGED" } });
  await expect(lstat(worktreePath)).resolves.toBeDefined();
  f.database.close();

  const status = await createGitFixture();
  const statusRequest = status.request("run_cleanup_status_race");
  const statusCreated = await status.manager.createOrReuse(statusRequest);
  if (!statusCreated.ok) throw new Error("expected worktree");
  const statusPath = status.database
    .query<{ worktree_path: string }, [string]>(
      "SELECT worktree_path FROM local_run_worktrees WHERE worktree_key = ?",
    )
    .get(statusCreated.value.id)?.worktree_path;
  if (!statusPath) throw new Error("missing worktree");
  status.claims.set("publish_status_race", {
    kind: "ATTEMPT_PUBLISH",
    authorizationId: "auth_publish_status_race",
    runnerId: "runner_1",
    runId: statusRequest.runId,
    worktreeKey: statusCreated.value.id,
    expectedHead: statusRequest.baseCommit,
    attemptId: "attempt_status_race",
    sessionId: "session_status_race",
    sessionFence: 1,
    remoteIdentity: statusRequest.remoteIdentity,
    remoteRef: statusRequest.remoteRef,
    expiresAt: 2_000,
  });
  expect(
    await status.manager.publish(statusCreated.value, {
      kind: "ATTEMPT_PUBLISH",
      token: "publish_status_race",
    }),
  ).toMatchObject({ ok: true });
  status.claims.set("cleanup_status_race", {
    kind: "COMMITTED_CLEANUP",
    authorizationId: "auth_cleanup_status_race",
    runnerId: "runner_1",
    runId: statusRequest.runId,
    worktreeKey: statusCreated.value.id,
    expectedHead: statusRequest.baseCommit,
    runState: "COMPLETED",
    noActiveAttempt: true,
    expiresAt: 2_000,
  });
  const statusRaceManager = createWorktreeManager({
    database: status.database,
    managedRoot: status.managedRoot,
    clock: () => 1_000,
    id: (kind) => `${kind}_status_race`,
    pinRun: async () => ({
      ok: false,
      error: { code: "UNEXPECTED_PIN", message: "Unexpected pin.", retry: "NEVER" },
    }),
    authorizations: {
      verify: async (token) => {
        const value = status.claims.get(token);
        return value
          ? { ok: true, value }
          : {
              ok: false,
              error: { code: "NO_AUTH", message: "No authority.", retry: "NEVER" },
            };
      },
      consume: async () => {
        await writeFile(join(statusPath, "appeared-after-consume.txt"), "race\n");
        return { ok: true, value: undefined };
      },
    },
  });
  expect(
    await statusRaceManager.cleanup(statusCreated.value, {
      kind: "COMMITTED_CLEANUP",
      token: "cleanup_status_race",
    }),
  ).toMatchObject({ ok: true, value: { reason: "HEAD_CHANGED", untrackedFileCount: 1 } });
  status.database.close();
});

test("concurrent calls serialize per repository while separate repositories progress independently", async () => {
  const same = await createGitFixture();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const secondEntered = deferred();
  const pinOrder: string[] = [];
  let nextId = 0;
  const sameManager = createWorktreeManager({
    database: same.database,
    managedRoot: same.managedRoot,
    clock: () => 1_000,
    id: (kind) => `${kind}_serial_${++nextId}`,
    pinRun: async (input) => {
      pinOrder.push(input.runId);
      if (input.runId === "run_serial_1") {
        firstEntered.resolve();
        await releaseFirst.promise;
      } else {
        secondEntered.resolve();
      }
      return { ok: true, value: { runRevision: input.expectedRunRevision + 1 } };
    },
    authorizations: {
      verify: async () => ({
        ok: false,
        error: { code: "NO_AUTH", message: "No authority.", retry: "NEVER" },
      }),
      consume: async () => ({ ok: true, value: undefined }),
    },
  });
  const first = sameManager.createOrReuse(same.request("run_serial_1"));
  await firstEntered.promise;
  const second = sameManager.createOrReuse(same.request("run_serial_2"));
  const earlySecond = await Promise.race([
    secondEntered.promise.then(() => "ENTERED" as const),
    new Promise<"WAITING">((resolve) => setTimeout(() => resolve("WAITING"), 50)),
  ]);
  expect(earlySecond).toBe("WAITING");
  releaseFirst.resolve();
  expect(await first).toMatchObject({ ok: true });
  expect(await second).toMatchObject({ ok: true });
  expect(pinOrder).toEqual(["run_serial_1", "run_serial_2"]);
  same.database.close();

  const left = await createGitFixture();
  const right = await createGitFixture();
  const leftEntered = deferred();
  const releaseLeft = deferred();
  const rightEntered = deferred();
  const makeManager = (
    f: Awaited<ReturnType<typeof createGitFixture>>,
    enter: ReturnType<typeof deferred>,
    release?: ReturnType<typeof deferred>,
  ) =>
    createWorktreeManager({
      database: f.database,
      managedRoot: f.managedRoot,
      clock: () => 1_000,
      id: (kind) => `${kind}_${f === left ? "left" : "right"}`,
      pinRun: async (input) => {
        enter.resolve();
        if (release) await release.promise;
        return { ok: true, value: { runRevision: input.expectedRunRevision + 1 } };
      },
      authorizations: {
        verify: async () => ({
          ok: false,
          error: { code: "NO_AUTH", message: "No authority.", retry: "NEVER" },
        }),
        consume: async () => ({ ok: true, value: undefined }),
      },
    });
  const leftManager = makeManager(left, leftEntered, releaseLeft);
  const rightManager = makeManager(right, rightEntered);
  const leftCreation = leftManager.createOrReuse(left.request("run_left"));
  await leftEntered.promise;
  const rightCreation = rightManager.createOrReuse(right.request("run_right"));
  expect(
    await Promise.race([
      rightEntered.promise.then(() => "ENTERED" as const),
      new Promise<"BLOCKED">((resolve) => setTimeout(() => resolve("BLOCKED"), 1_000)),
    ]),
  ).toBe("ENTERED");
  releaseLeft.resolve();
  expect(await leftCreation).toMatchObject({ ok: true });
  expect(await rightCreation).toMatchObject({ ok: true });
  left.database.close();
  right.database.close();
});

test("cleanup failures remain truthful retained work after remove or branch-CAS failure", async () => {
  for (const failurePoint of ["REMOVE", "BRANCH_CAS"] as const) {
    const f = await createGitFixture();
    const request = f.request(`run_cleanup_failure_${failurePoint.toLowerCase()}`);
    const created = await f.manager.createOrReuse(request);
    if (!created.ok) throw new Error("expected worktree");
    const worktreePath = f.database
      .query<{ worktree_path: string }, [string]>(
        "SELECT worktree_path FROM local_run_worktrees WHERE worktree_key = ?",
      )
      .get(created.value.id)?.worktree_path;
    if (!worktreePath) throw new Error("missing worktree");
    f.claims.set(`publish_${failurePoint}`, {
      kind: "ATTEMPT_PUBLISH",
      authorizationId: `auth_publish_${failurePoint}`,
      runnerId: "runner_1",
      runId: request.runId,
      worktreeKey: created.value.id,
      expectedHead: request.baseCommit,
      attemptId: `attempt_${failurePoint}`,
      sessionId: `session_${failurePoint}`,
      sessionFence: 1,
      remoteIdentity: request.remoteIdentity,
      remoteRef: request.remoteRef,
      expiresAt: 2_000,
    });
    expect(
      await f.manager.publish(created.value, {
        kind: "ATTEMPT_PUBLISH",
        token: `publish_${failurePoint}`,
      }),
    ).toMatchObject({ ok: true });
    f.claims.set(`cleanup_${failurePoint}`, {
      kind: "COMMITTED_CLEANUP",
      authorizationId: `auth_cleanup_${failurePoint}`,
      runnerId: "runner_1",
      runId: request.runId,
      worktreeKey: created.value.id,
      expectedHead: request.baseCommit,
      runState: "COMPLETED",
      noActiveAttempt: true,
      expiresAt: 2_000,
    });
    const processGit = createProcessGitCommandRunner();
    const failingManager = createWorktreeManager({
      database: f.database,
      managedRoot: f.managedRoot,
      clock: () => 1_000,
      id: (kind) => `${kind}_cleanup_failure`,
      pinRun: async () => ({
        ok: false,
        error: { code: "UNEXPECTED_PIN", message: "Unexpected pin.", retry: "NEVER" },
      }),
      authorizations: {
        verify: async (token) => {
          const value = f.claims.get(token);
          return value
            ? { ok: true, value }
            : {
                ok: false,
                error: { code: "NO_AUTH", message: "No authority.", retry: "NEVER" },
              };
        },
        consume: async () => ({ ok: true, value: undefined }),
      },
      git: {
        async run(directory, args) {
          if (
            (failurePoint === "REMOVE" && args[0] === "worktree" && args[1] === "remove") ||
            (failurePoint === "BRANCH_CAS" && args[0] === "update-ref" && args[1] === "-d")
          ) {
            return { exitCode: 1, stdout: "", truncated: false };
          }
          return processGit.run(directory, args);
        },
      },
    });
    expect(
      await failingManager.cleanup(created.value, {
        kind: "COMMITTED_CLEANUP",
        token: `cleanup_${failurePoint}`,
      }),
    ).toMatchObject({ ok: true, value: { reason: "CLEANUP_FAILED" } });
    try {
      expect(await lstat(worktreePath)).toBeDefined();
    } catch {
      throw new Error(`retained worktree missing after ${failurePoint}`);
    }
    expect(await git(worktreePath, "rev-parse", "HEAD")).toBe(request.baseCommit);
    expect(
      f.database
        .query<{ state: string }, [string]>(
          "SELECT state FROM local_run_worktrees WHERE worktree_key = ?",
        )
        .get(created.value.id)?.state,
    ).toBe("RETAINED");
    f.database.close();
  }
});

test("retained evidence is bounded, truncated, repository-relative, and secret-minimizing", async () => {
  const f = await createGitFixture();
  const request = f.request("run_bounded_evidence");
  const created = await f.manager.createOrReuse(request);
  if (!created.ok) throw new Error("expected worktree");
  const worktreePath = f.database
    .query<{ worktree_path: string }, [string]>(
      "SELECT worktree_path FROM local_run_worktrees WHERE worktree_key = ?",
    )
    .get(created.value.id)?.worktree_path;
  if (!worktreePath) throw new Error("missing worktree");
  await Promise.all(
    Array.from({ length: 140 }, (_, index) =>
      writeFile(join(worktreePath, `file-${String(index).padStart(3, "0")}.txt`), "x"),
    ),
  );
  await writeFile(join(worktreePath, "unsafe\nname.txt"), "unsafe");
  f.claims.set("cleanup_bounded", {
    kind: "COMMITTED_CLEANUP",
    authorizationId: "auth_cleanup_bounded",
    runnerId: "runner_1",
    runId: request.runId,
    worktreeKey: created.value.id,
    expectedHead: request.baseCommit,
    runState: "COMPLETED",
    noActiveAttempt: true,
    expiresAt: 2_000,
  });
  const retained = await f.manager.cleanup(created.value, {
    kind: "COMMITTED_CLEANUP",
    token: "cleanup_bounded",
  });
  expect(retained).toMatchObject({
    ok: true,
    value: {
      kind: "RETAINED_LOCAL_WORK",
      reason: "UNTRACKED_FILES",
      untrackedFileCount: 141,
      truncated: true,
    },
  });
  if (!retained.ok || retained.value.kind !== "RETAINED_LOCAL_WORK") {
    throw new Error("expected retained evidence");
  }
  expect(retained.value.changedPaths).toHaveLength(128);
  expect(
    retained.value.changedPaths.every((path) => !path.startsWith("/") && !path.includes("\n")),
  ).toBe(true);
  const serialized = JSON.stringify(retained.value);
  expect(serialized).not.toContain(f.root);
  expect(serialized).not.toContain(f.remote);
  expect(serialized).not.toContain("repository_root");
  f.database.close();
});

test("runner migration upgrades v4 to v5 and rejects gaps, future versions, and corruption", async () => {
  const migrationDirectory = join(process.cwd(), "src", "runner", "db", "migrations");
  const migrations = await Promise.all(
    [1, 2, 3, 4].map(async (version) =>
      readFile(
        join(
          migrationDirectory,
          `${String(version).padStart(4, "0")}_${
            ["profiles_processes", "failed_starts", "start_fence", "semantic_outbox"][version - 1]
          }.sql`,
        ),
        "utf8",
      ),
    ),
  );
  const v4 = () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of migrations) database.exec(migration);
    return database;
  };

  const upgraded = v4();
  migrateRunnerDatabase(upgraded, false);
  expect(
    upgraded
      .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => row.version),
  ).toEqual([1, 2, 3, 4, 5]);
  expect(
    upgraded.query<{ strict: number }, []>("PRAGMA table_list('local_run_worktrees')").get()
      ?.strict,
  ).toBe(1);
  upgraded.exec("DROP TABLE local_run_worktrees");
  expect(() => migrateRunnerDatabase(upgraded, false)).toThrow("RUNNER_STATE_CORRUPT");
  upgraded.close();

  const future = v4();
  future.query("UPDATE schema_migrations SET version = 6 WHERE version = 4").run();
  expect(() => migrateRunnerDatabase(future, false)).toThrow("RUNNER_STATE_CORRUPT");
  future.close();

  const gap = v4();
  gap.query("DELETE FROM schema_migrations WHERE version = 3").run();
  expect(() => migrateRunnerDatabase(gap, false)).toThrow("RUNNER_STATE_CORRUPT");
  gap.close();
});
