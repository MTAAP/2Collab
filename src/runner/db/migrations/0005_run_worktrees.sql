CREATE TABLE local_run_worktrees (
  run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 128),
  worktree_key TEXT NOT NULL UNIQUE CHECK (
    length(worktree_key) BETWEEN 1 AND 128
    AND worktree_key GLOB '[A-Za-z0-9]*'
    AND worktree_key NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  repository_id TEXT NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 128),
  runner_id TEXT NOT NULL CHECK (length(runner_id) BETWEEN 1 AND 128),
  owner_member_id TEXT NOT NULL CHECK (length(owner_member_id) BETWEEN 1 AND 128),
  repository_root TEXT NOT NULL CHECK (length(repository_root) BETWEEN 1 AND 4096),
  worktree_path TEXT NOT NULL UNIQUE CHECK (length(worktree_path) BETWEEN 1 AND 4096),
  base_commit TEXT NOT NULL CHECK (
    length(base_commit) IN (40, 64) AND base_commit NOT GLOB '*[^0-9a-f]*'
  ),
  branch_ref TEXT NOT NULL UNIQUE CHECK (length(branch_ref) BETWEEN 1 AND 255),
  remote_name TEXT NOT NULL CHECK (
    length(remote_name) BETWEEN 1 AND 128
    AND remote_name GLOB '[A-Za-z0-9]*'
    AND remote_name NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  remote_identity TEXT NOT NULL CHECK (length(remote_identity) BETWEEN 1 AND 128),
  remote_ref TEXT NOT NULL CHECK (length(remote_ref) BETWEEN 1 AND 255),
  state TEXT NOT NULL CHECK (state IN ('CREATING', 'READY', 'RETAINED', 'REMOVED', 'DISCARDED')),
  pinned_run_revision INTEGER CHECK (pinned_run_revision IS NULL OR pinned_run_revision > 0),
  current_head TEXT CHECK (
    current_head IS NULL OR (
      length(current_head) IN (40, 64) AND current_head NOT GLOB '*[^0-9a-f]*'
    )
  ),
  published_commit TEXT CHECK (
    published_commit IS NULL OR (
      length(published_commit) IN (40, 64) AND published_commit NOT GLOB '*[^0-9a-f]*'
    )
  ),
  published_verified_at INTEGER CHECK (published_verified_at IS NULL OR published_verified_at >= 0),
  retained_work_id TEXT UNIQUE CHECK (
    retained_work_id IS NULL OR length(retained_work_id) BETWEEN 1 AND 128
  ),
  retained_reason TEXT CHECK (
    retained_reason IS NULL OR retained_reason IN (
      'RUN_NOT_TERMINAL', 'ACTIVE_ATTEMPT', 'TRACKED_CHANGES', 'UNTRACKED_FILES',
      'UNPUBLISHED_HEAD', 'REMOTE_UNAVAILABLE', 'HEAD_CHANGED', 'CLEANUP_FAILED',
      'AUTHORITY_UNAVAILABLE'
    )
  ),
  observation_revision INTEGER NOT NULL DEFAULT 0 CHECK (observation_revision >= 0),
  observation_digest TEXT CHECK (
    observation_digest IS NULL OR (
      length(observation_digest) = 64 AND observation_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  summary_json TEXT CHECK (
    summary_json IS NULL OR (json_valid(summary_json) AND length(CAST(summary_json AS BLOB)) <= 32768)
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (state = 'CREATING' AND current_head IS NULL)
    OR (state IN ('READY', 'RETAINED', 'REMOVED', 'DISCARDED') AND current_head IS NOT NULL)
  ),
  CHECK (
    (published_commit IS NULL AND published_verified_at IS NULL)
    OR (published_commit IS NOT NULL AND published_verified_at IS NOT NULL)
  ),
  CHECK (
    state <> 'RETAINED'
    OR (
      retained_work_id IS NOT NULL AND retained_reason IS NOT NULL
      AND observation_revision > 0 AND observation_digest IS NOT NULL AND summary_json IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX local_run_worktrees_repository_state
  ON local_run_worktrees(repository_root, state);

CREATE INDEX local_run_worktrees_retained_owner
  ON local_run_worktrees(runner_id, owner_member_id, state);

INSERT INTO schema_migrations(version, applied_at)
VALUES (5, CAST(strftime('%s', 'now') AS INTEGER));
