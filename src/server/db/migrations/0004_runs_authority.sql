CREATE TABLE coordination_records (
  id TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 128)
    CHECK (id GLOB '[A-Za-z0-9]*' AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  project_id TEXT NOT NULL REFERENCES projects(id)
    CHECK (length(project_id) BETWEEN 1 AND 128),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160 AND title = trim(title)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (id, project_id)
) STRICT;

CREATE TRIGGER coordination_record_project_immutable
BEFORE UPDATE OF id, project_id, created_at ON coordination_records
BEGIN
  SELECT RAISE(ABORT, 'COORDINATION_RECORD_IDENTITY_IMMUTABLE');
END;

CREATE TABLE coordination_source_references (
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL
    CHECK (length(connector_id) BETWEEN 1 AND 128)
    CHECK (connector_id GLOB '[A-Za-z0-9]*' AND connector_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  source_item_id TEXT NOT NULL CHECK (length(source_item_id) BETWEEN 1 AND 256),
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('GITHUB_ISSUE', 'GITHUB_PULL_REQUEST', 'OUTLINE_DOCUMENT')),
  coordination_record_id TEXT NOT NULL,
  observed_revision TEXT NOT NULL CHECK (length(observed_revision) BETWEEN 1 AND 128),
  linked_at INTEGER NOT NULL CHECK (linked_at >= 0),
  PRIMARY KEY (project_id, connector_id, source_item_id),
  FOREIGN KEY (coordination_record_id, project_id)
    REFERENCES coordination_records(id, project_id)
) STRICT;

CREATE INDEX coordination_source_record
  ON coordination_source_references(coordination_record_id, source_kind);

CREATE TRIGGER coordination_source_reference_immutable
BEFORE UPDATE ON coordination_source_references
BEGIN
  SELECT RAISE(ABORT, 'COORDINATION_SOURCE_IMMUTABLE');
END;

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 128)
    CHECK (id GLOB '[A-Za-z0-9]*' AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  coordination_record_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  state TEXT NOT NULL
    CHECK (state IN ('QUEUED', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  goal TEXT NOT NULL CHECK (length(goal) BETWEEN 1 AND 16384),
  repository_id TEXT NOT NULL
    CHECK (length(repository_id) BETWEEN 1 AND 128)
    CHECK (repository_id GLOB '[A-Za-z0-9]*' AND repository_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  repository_mode TEXT NOT NULL CHECK (repository_mode IN ('MUTATING', 'INSPECT_ONLY')),
  repository_assurance TEXT NOT NULL CHECK (repository_assurance IN ('ADVISORY', 'ENFORCED')),
  base_origin TEXT NOT NULL CHECK (base_origin IN ('EXACT', 'RESOLVED_DEFAULT')),
  base_commit TEXT NOT NULL
    CHECK (length(base_commit) IN (40, 64) AND base_commit NOT GLOB '*[^a-f0-9]*'),
  base_branch TEXT NOT NULL CHECK (length(base_branch) BETWEEN 1 AND 255),
  intended_branch TEXT CHECK (intended_branch IS NULL OR length(intended_branch) BETWEEN 1 AND 255),
  worktree_identity TEXT NOT NULL UNIQUE
    CHECK (length(worktree_identity) BETWEEN 1 AND 128)
    CHECK (worktree_identity GLOB '[A-Za-z0-9]*' AND worktree_identity NOT GLOB '*[^A-Za-z0-9_-]*'),
  effective_configuration_id TEXT NOT NULL
    CHECK (length(effective_configuration_id) BETWEEN 1 AND 128),
  effective_configuration_version INTEGER NOT NULL CHECK (effective_configuration_version > 0),
  effective_configuration_digest TEXT NOT NULL
    CHECK (length(effective_configuration_digest) = 64
      AND effective_configuration_digest NOT GLOB '*[^a-f0-9]*'),
  dispatcher_kind TEXT NOT NULL CHECK (dispatcher_kind IN ('MEMBER', 'SCHEDULER', 'RUNNER')),
  dispatcher_id TEXT NOT NULL CHECK (length(dispatcher_id) BETWEEN 1 AND 128),
  dispatcher_context_id TEXT CHECK (
    dispatcher_context_id IS NULL OR length(dispatcher_context_id) BETWEEN 1 AND 128
  ),
  waiting_reason TEXT CHECK (
    waiting_reason IS NULL OR waiting_reason IN ('HUMAN_INPUT', 'APPROVAL', 'DEPENDENCY', 'RETRY', 'BLOCKED')
  ),
  terminal_reason TEXT CHECK (
    terminal_reason IS NULL OR terminal_reason IN (
      'GOAL_ACHIEVED', 'DELIVERED', 'NO_CHANGES', 'BLOCKED', 'ESCALATED',
      'MEMBER_REQUEST', 'DEADLINE', 'WORKFLOW', 'REVOCATION', 'FAILED'
    )
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  started_at INTEGER CHECK (started_at IS NULL OR started_at >= created_at),
  terminal_at INTEGER CHECK (
    terminal_at IS NULL OR (started_at IS NOT NULL AND terminal_at >= started_at)
  ),
  UNIQUE (id, project_id),
  FOREIGN KEY (coordination_record_id, project_id)
    REFERENCES coordination_records(id, project_id),
  CHECK (state != 'QUEUED' OR (
    started_at IS NULL AND terminal_at IS NULL AND waiting_reason IS NULL AND terminal_reason IS NULL
  )),
  CHECK (state != 'RUNNING' OR (
    started_at IS NOT NULL AND terminal_at IS NULL AND waiting_reason IS NULL AND terminal_reason IS NULL
  )),
  CHECK (state != 'WAITING' OR (
    started_at IS NOT NULL AND terminal_at IS NULL AND waiting_reason IS NOT NULL AND terminal_reason IS NULL
  )),
  CHECK (state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') OR (
    terminal_at IS NOT NULL AND terminal_reason IS NOT NULL AND waiting_reason IS NULL
  ))
) STRICT;

CREATE INDEX agent_runs_coordination_state
  ON agent_runs(coordination_record_id, state, created_at);

CREATE TRIGGER agent_run_provenance_immutable
BEFORE UPDATE OF
  id, coordination_record_id, project_id, goal, repository_id, repository_mode,
  repository_assurance, base_origin, base_commit, base_branch, intended_branch,
  worktree_identity, effective_configuration_id, effective_configuration_version,
  effective_configuration_digest, dispatcher_kind, dispatcher_id, dispatcher_context_id, created_at
ON agent_runs
BEGIN
  SELECT RAISE(ABORT, 'RUN_PROVENANCE_IMMUTABLE');
END;

CREATE TABLE execution_attempts (
  id TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 128)
    CHECK (id GLOB '[A-Za-z0-9]*' AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  runner_id TEXT NOT NULL REFERENCES runners(id),
  runner_epoch INTEGER NOT NULL CHECK (runner_epoch > 0),
  mapping_revision INTEGER NOT NULL CHECK (mapping_revision > 0),
  profile_version_id TEXT NOT NULL CHECK (length(profile_version_id) BETWEEN 1 AND 128),
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  profile_fingerprint TEXT NOT NULL
    CHECK (length(profile_fingerprint) = 64 AND profile_fingerprint NOT GLOB '*[^a-f0-9]*'),
  exposure_revision INTEGER CHECK (exposure_revision IS NULL OR exposure_revision > 0),
  host TEXT NOT NULL CHECK (host IN ('NATIVE', 'ORCA')),
  interaction TEXT NOT NULL CHECK (interaction IN ('HEADLESS', 'INTERACTIVE')),
  state TEXT NOT NULL CHECK (
    state IN ('PENDING', 'STARTING', 'RUNNING', 'EXITED', 'FAILED_TO_START', 'CANCELLED', 'TIMED_OUT', 'LOST')
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  acknowledged_at INTEGER CHECK (acknowledged_at IS NULL OR acknowledged_at >= created_at),
  started_at INTEGER CHECK (
    started_at IS NULL OR (acknowledged_at IS NOT NULL AND started_at >= acknowledged_at)
  ),
  terminal_at INTEGER CHECK (
    terminal_at IS NULL OR terminal_at >= coalesce(started_at, acknowledged_at, created_at)
  ),
  exit_code INTEGER,
  signal TEXT CHECK (signal IS NULL OR length(signal) BETWEEN 1 AND 32),
  terminal_reason TEXT CHECK (
    terminal_reason IS NULL OR terminal_reason IN (
      'PROCESS_EXITED', 'START_FAILED', 'CANCELLED', 'TIMED_OUT', 'LOST'
    )
  ),
  UNIQUE (run_id, ordinal),
  UNIQUE (id, run_id),
  FOREIGN KEY (run_id, project_id) REFERENCES agent_runs(id, project_id),
  FOREIGN KEY (runner_id, project_id, mapping_revision)
    REFERENCES runner_mapping_versions(runner_id, project_id, revision),
  FOREIGN KEY (runner_id, profile_version_id, profile_version, profile_fingerprint)
    REFERENCES safe_profile_versions(runner_id, profile_id, version, fingerprint),
  CHECK (state != 'PENDING' OR (
    acknowledged_at IS NULL AND started_at IS NULL AND terminal_at IS NULL
      AND exit_code IS NULL AND signal IS NULL AND terminal_reason IS NULL
  )),
  CHECK (state != 'STARTING' OR (
    acknowledged_at IS NOT NULL AND started_at IS NULL AND terminal_at IS NULL
      AND exit_code IS NULL AND signal IS NULL AND terminal_reason IS NULL
  )),
  CHECK (state != 'RUNNING' OR (
    acknowledged_at IS NOT NULL AND started_at IS NOT NULL AND terminal_at IS NULL
      AND exit_code IS NULL AND signal IS NULL AND terminal_reason IS NULL
  )),
  CHECK (state NOT IN ('EXITED', 'FAILED_TO_START', 'CANCELLED', 'TIMED_OUT', 'LOST') OR (
    terminal_at IS NOT NULL AND terminal_reason IS NOT NULL
  )),
  CHECK (state != 'EXITED' OR exit_code IS NOT NULL),
  CHECK (state != 'FAILED_TO_START' OR started_at IS NULL)
) STRICT;

CREATE UNIQUE INDEX one_active_attempt_per_run
  ON execution_attempts(run_id)
  WHERE state IN ('PENDING', 'STARTING', 'RUNNING');

CREATE INDEX execution_attempts_runner_state
  ON execution_attempts(runner_id, state, created_at);

CREATE TRIGGER execution_attempt_assignment_immutable
BEFORE UPDATE OF
  id, run_id, project_id, ordinal, runner_id, runner_epoch, mapping_revision,
  profile_version_id, profile_version, profile_fingerprint, exposure_revision,
  host, interaction, created_at
ON execution_attempts
BEGIN
  SELECT RAISE(ABORT, 'ATTEMPT_ASSIGNMENT_IMMUTABLE');
END;

CREATE TABLE authority_snapshots (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES execution_attempts(id),
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_revision INTEGER NOT NULL CHECK (project_revision > 0),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('MEMBER', 'SCHEDULER', 'RUNNER')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  actor_context_id TEXT CHECK (actor_context_id IS NULL OR length(actor_context_id) BETWEEN 1 AND 128),
  runner_id TEXT NOT NULL REFERENCES runners(id),
  runner_owner_member_id TEXT NOT NULL REFERENCES members(id),
  runner_epoch INTEGER NOT NULL CHECK (runner_epoch > 0),
  runner_policy_revision INTEGER NOT NULL CHECK (runner_policy_revision > 0),
  mapping_revision INTEGER NOT NULL CHECK (mapping_revision > 0),
  profile_version_id TEXT NOT NULL CHECK (length(profile_version_id) BETWEEN 1 AND 128),
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  profile_fingerprint TEXT NOT NULL
    CHECK (length(profile_fingerprint) = 64 AND profile_fingerprint NOT GLOB '*[^a-f0-9]*'),
  exposure_revision INTEGER CHECK (exposure_revision IS NULL OR exposure_revision > 0),
  authorization_source TEXT NOT NULL CHECK (authorization_source IN ('OWNER', 'TEAM_EXPOSURE')),
  security_policy_version INTEGER NOT NULL CHECK (security_policy_version > 0),
  security_digest TEXT NOT NULL
    CHECK (length(security_digest) = 64 AND security_digest NOT GLOB '*[^a-f0-9]*'),
  repository_id TEXT NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 128),
  repository_mode TEXT NOT NULL CHECK (repository_mode IN ('MUTATING', 'INSPECT_ONLY')),
  repository_assurance TEXT NOT NULL CHECK (repository_assurance IN ('ADVISORY', 'ENFORCED')),
  base_commit TEXT NOT NULL
    CHECK (length(base_commit) IN (40, 64) AND base_commit NOT GLOB '*[^a-f0-9]*'),
  base_branch TEXT NOT NULL CHECK (length(base_branch) BETWEEN 1 AND 255),
  intended_branch TEXT CHECK (intended_branch IS NULL OR length(intended_branch) BETWEEN 1 AND 255),
  effective_configuration_id TEXT NOT NULL CHECK (length(effective_configuration_id) BETWEEN 1 AND 128),
  effective_configuration_version INTEGER NOT NULL CHECK (effective_configuration_version > 0),
  effective_configuration_digest TEXT NOT NULL
    CHECK (length(effective_configuration_digest) = 64
      AND effective_configuration_digest NOT GLOB '*[^a-f0-9]*'),
  permit_seconds INTEGER NOT NULL CHECK (permit_seconds BETWEEN 1 AND 300),
  authority_session_seconds INTEGER NOT NULL CHECK (authority_session_seconds BETWEEN 1 AND 300),
  authority_renewal_seconds INTEGER NOT NULL CHECK (
    authority_renewal_seconds BETWEEN 1 AND authority_session_seconds
  ),
  mutation_disconnect_grace_seconds INTEGER NOT NULL
    CHECK (mutation_disconnect_grace_seconds BETWEEN 1 AND 300),
  snapshot_digest TEXT NOT NULL UNIQUE
    CHECK (length(snapshot_digest) = 64 AND snapshot_digest NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (attempt_id, run_id) REFERENCES execution_attempts(id, run_id),
  FOREIGN KEY (run_id, project_id) REFERENCES agent_runs(id, project_id),
  CHECK (authorization_source != 'OWNER' OR exposure_revision IS NULL),
  CHECK (authorization_source != 'TEAM_EXPOSURE' OR exposure_revision IS NOT NULL)
) STRICT;

CREATE TRIGGER authority_snapshot_immutable
BEFORE UPDATE ON authority_snapshots
BEGIN
  SELECT RAISE(ABORT, 'AUTHORITY_SNAPSHOT_IMMUTABLE');
END;

CREATE TABLE dispatch_permits (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES execution_attempts(id),
  authority_snapshot_id TEXT NOT NULL UNIQUE REFERENCES authority_snapshots(id),
  claims_hash TEXT NOT NULL UNIQUE
    CHECK (length(claims_hash) = 64 AND claims_hash NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('ISSUED', 'CONSUMED', 'REVOKED', 'EXPIRED')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at BETWEEN issued_at AND expires_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CHECK (state != 'ISSUED' OR (consumed_at IS NULL AND revoked_at IS NULL)),
  CHECK (state != 'CONSUMED' OR (consumed_at IS NOT NULL AND revoked_at IS NULL)),
  CHECK (state != 'REVOKED' OR revoked_at IS NOT NULL)
) STRICT;

CREATE TRIGGER dispatch_permit_claims_immutable
BEFORE UPDATE OF id, attempt_id, authority_snapshot_id, claims_hash, issued_at, expires_at
ON dispatch_permits
BEGIN
  SELECT RAISE(ABORT, 'DISPATCH_PERMIT_CLAIMS_IMMUTABLE');
END;

CREATE TABLE runner_dispatch_outbox (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  delivery_kind TEXT NOT NULL CHECK (delivery_kind = 'LAUNCH_ATTEMPT'),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES execution_attempts(id),
  runner_id TEXT NOT NULL REFERENCES runners(id),
  runner_epoch INTEGER NOT NULL CHECK (runner_epoch > 0),
  authority_snapshot_id TEXT NOT NULL UNIQUE REFERENCES authority_snapshots(id),
  permit_id TEXT NOT NULL UNIQUE REFERENCES dispatch_permits(id),
  semantic_digest TEXT NOT NULL UNIQUE
    CHECK (length(semantic_digest) = 64 AND semantic_digest NOT GLOB '*[^a-f0-9]*'),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'DISPATCHED', 'ACKNOWLEDGED', 'FAILED')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 1000),
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR (
      length(last_error_code) BETWEEN 1 AND 64
      AND last_error_code GLOB '[A-Z]*'
      AND last_error_code NOT GLOB '*[^A-Z0-9_]*'
    )
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  dispatched_at INTEGER CHECK (dispatched_at IS NULL OR dispatched_at BETWEEN created_at AND expires_at),
  acknowledged_at INTEGER CHECK (
    acknowledged_at IS NULL OR (dispatched_at IS NOT NULL AND acknowledged_at >= dispatched_at)
  ),
  CHECK (status != 'PENDING' OR (
    dispatched_at IS NULL AND acknowledged_at IS NULL AND last_error_code IS NULL
  )),
  CHECK (status != 'DISPATCHED' OR (dispatched_at IS NOT NULL AND acknowledged_at IS NULL)),
  CHECK (status != 'ACKNOWLEDGED' OR acknowledged_at IS NOT NULL),
  CHECK (status != 'FAILED' OR last_error_code IS NOT NULL)
) STRICT;

CREATE INDEX pending_runner_dispatch_outbox
  ON runner_dispatch_outbox(runner_id, created_at)
  WHERE status IN ('PENDING', 'DISPATCHED');

CREATE TRIGGER runner_dispatch_outbox_payload_immutable
BEFORE UPDATE OF
  id, delivery_kind, attempt_id, runner_id, runner_epoch, authority_snapshot_id,
  permit_id, semantic_digest, created_at, expires_at
ON runner_dispatch_outbox
BEGIN
  SELECT RAISE(ABORT, 'RUNNER_DISPATCH_PAYLOAD_IMMUTABLE');
END;

INSERT INTO schema_migrations(version, applied_at) VALUES (4, unixepoch());
