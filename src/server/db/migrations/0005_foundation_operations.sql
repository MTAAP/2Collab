CREATE TABLE run_execution_policies (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id),
  maximum_attempts INTEGER NOT NULL CHECK (maximum_attempts BETWEEN 1 AND 1000),
  deadline_at INTEGER NOT NULL CHECK (deadline_at > created_at),
  permit_seconds INTEGER NOT NULL CHECK (permit_seconds BETWEEN 1 AND 300),
  authority_session_seconds INTEGER NOT NULL CHECK (authority_session_seconds BETWEEN 1 AND 300),
  authority_renewal_seconds INTEGER NOT NULL
    CHECK (authority_renewal_seconds BETWEEN 1 AND authority_session_seconds),
  mutation_disconnect_grace_seconds INTEGER NOT NULL
    CHECK (mutation_disconnect_grace_seconds BETWEEN 1 AND 300),
  connector_epochs_digest TEXT NOT NULL
    CHECK (length(connector_epochs_digest) = 64 AND connector_epochs_digest NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TRIGGER run_execution_policy_immutable
BEFORE UPDATE ON run_execution_policies
BEGIN
  SELECT RAISE(ABORT, 'RUN_EXECUTION_POLICY_IMMUTABLE');
END;

CREATE TABLE run_execution_connector_epochs (
  run_id TEXT NOT NULL REFERENCES run_execution_policies(run_id),
  connector_id TEXT NOT NULL REFERENCES connector_epochs(connector_id),
  connector_epoch INTEGER NOT NULL CHECK (connector_epoch > 0),
  PRIMARY KEY (run_id, connector_id)
) STRICT;

CREATE TRIGGER run_execution_connector_epoch_immutable
BEFORE UPDATE ON run_execution_connector_epochs
BEGIN
  SELECT RAISE(ABORT, 'RUN_EXECUTION_CONNECTOR_EPOCH_IMMUTABLE');
END;

CREATE TABLE work_item_mutation_guards (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  coordination_record_id TEXT NOT NULL REFERENCES coordination_records(id),
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id),
  fence INTEGER NOT NULL CHECK (fence > 0),
  state TEXT NOT NULL CHECK (state IN ('HELD', 'RELEASED', 'REVOKED')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  reserved_at INTEGER NOT NULL CHECK (reserved_at >= 0),
  released_at INTEGER CHECK (released_at IS NULL OR released_at >= reserved_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= reserved_at),
  CHECK (state != 'HELD' OR (released_at IS NULL AND revoked_at IS NULL)),
  CHECK (state != 'RELEASED' OR released_at IS NOT NULL),
  CHECK (state != 'REVOKED' OR revoked_at IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX one_held_mutation_guard
  ON work_item_mutation_guards(coordination_record_id) WHERE state = 'HELD';

CREATE TRIGGER mutation_guard_identity_immutable
BEFORE UPDATE OF id, coordination_record_id, run_id, reserved_at ON work_item_mutation_guards
BEGIN
  SELECT RAISE(ABORT, 'MUTATION_GUARD_IDENTITY_IMMUTABLE');
END;

CREATE TABLE mutation_guard_overrides (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  coordination_record_id TEXT NOT NULL REFERENCES coordination_records(id),
  mutation_guard_id TEXT NOT NULL REFERENCES work_item_mutation_guards(id),
  guarded_run_id TEXT NOT NULL REFERENCES agent_runs(id),
  guarded_run_revision INTEGER NOT NULL CHECK (guarded_run_revision > 0),
  colliding_run_id TEXT NOT NULL REFERENCES agent_runs(id),
  colliding_run_revision INTEGER NOT NULL CHECK (colliding_run_revision > 0),
  guard_fence INTEGER NOT NULL CHECK (guard_fence > 0),
  guard_revision INTEGER NOT NULL CHECK (guard_revision > 0),
  actor_member_id TEXT NOT NULL REFERENCES members(id),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 240),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (mutation_guard_id, colliding_run_id, colliding_run_revision),
  CHECK (guarded_run_id != colliding_run_id)
) STRICT;

CREATE INDEX mutation_guard_overrides_record_created
  ON mutation_guard_overrides(coordination_record_id, created_at);

CREATE TRIGGER mutation_guard_override_immutable
BEFORE UPDATE ON mutation_guard_overrides
BEGIN
  SELECT RAISE(ABORT, 'MUTATION_GUARD_OVERRIDE_IMMUTABLE');
END;

CREATE TRIGGER mutation_guard_override_delete_denied
BEFORE DELETE ON mutation_guard_overrides
BEGIN
  SELECT RAISE(ABORT, 'MUTATION_GUARD_OVERRIDE_DELETE_DENIED');
END;

CREATE TABLE authority_sessions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id),
  runner_id TEXT NOT NULL REFERENCES runners(id),
  runner_epoch INTEGER NOT NULL CHECK (runner_epoch > 0),
  connection_id TEXT NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 128),
  fence INTEGER NOT NULL CHECK (fence > 0),
  repository_mode TEXT NOT NULL CHECK (repository_mode IN ('MUTATING', 'INSPECT_ONLY')),
  repository_assurance TEXT NOT NULL CHECK (repository_assurance IN ('ADVISORY', 'ENFORCED')),
  connector_epochs_digest TEXT NOT NULL
    CHECK (length(connector_epochs_digest) = 64 AND connector_epochs_digest NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'RELEASED', 'REVOKED', 'EXPIRED')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  renewed_at INTEGER CHECK (renewed_at IS NULL OR renewed_at >= issued_at),
  released_at INTEGER CHECK (released_at IS NULL OR released_at >= issued_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CHECK (state != 'ACTIVE' OR (released_at IS NULL AND revoked_at IS NULL)),
  CHECK (state != 'RELEASED' OR released_at IS NOT NULL),
  CHECK (state != 'REVOKED' OR revoked_at IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX active_authority_session_by_attempt
  ON authority_sessions(attempt_id) WHERE state = 'ACTIVE';

CREATE INDEX authority_sessions_runner_state
  ON authority_sessions(runner_id, state, expires_at);

CREATE TABLE authority_session_connector_epochs (
  session_id TEXT NOT NULL REFERENCES authority_sessions(id),
  connector_id TEXT NOT NULL REFERENCES connector_epochs(connector_id),
  connector_epoch INTEGER NOT NULL CHECK (connector_epoch > 0),
  PRIMARY KEY (session_id, connector_id)
) STRICT;

CREATE TRIGGER authority_session_connector_epoch_immutable
BEFORE UPDATE ON authority_session_connector_epochs
BEGIN
  SELECT RAISE(ABORT, 'AUTHORITY_SESSION_CONNECTOR_EPOCH_IMMUTABLE');
END;

CREATE TRIGGER authority_session_identity_immutable
BEFORE UPDATE OF
  id, attempt_id, runner_id, runner_epoch, connection_id, repository_mode,
  repository_assurance, issued_at
ON authority_sessions
BEGIN
  SELECT RAISE(ABORT, 'AUTHORITY_SESSION_IDENTITY_IMMUTABLE');
END;

CREATE TABLE mutation_leases (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  session_id TEXT NOT NULL REFERENCES authority_sessions(id),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id),
  mutation_guard_id TEXT NOT NULL REFERENCES work_item_mutation_guards(id),
  fence INTEGER NOT NULL CHECK (fence > 0),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'RELEASED', 'REVOKED', 'EXPIRED')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  disconnect_grace_expires_at INTEGER NOT NULL CHECK (disconnect_grace_expires_at >= expires_at),
  renewed_at INTEGER CHECK (renewed_at IS NULL OR renewed_at >= issued_at),
  released_at INTEGER CHECK (released_at IS NULL OR released_at >= issued_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CHECK (state != 'ACTIVE' OR (released_at IS NULL AND revoked_at IS NULL)),
  CHECK (state != 'RELEASED' OR released_at IS NOT NULL),
  CHECK (state != 'REVOKED' OR revoked_at IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX active_mutation_lease_by_session
  ON mutation_leases(session_id) WHERE state = 'ACTIVE';

CREATE TRIGGER mutation_lease_identity_immutable
BEFORE UPDATE OF
  id, session_id, run_id, attempt_id, mutation_guard_id, issued_at
ON mutation_leases
BEGIN
  SELECT RAISE(ABORT, 'MUTATION_LEASE_IDENTITY_IMMUTABLE');
END;

CREATE TABLE operation_authorizations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  session_id TEXT NOT NULL REFERENCES authority_sessions(id),
  session_fence INTEGER NOT NULL CHECK (session_fence > 0),
  mutation_lease_fence INTEGER CHECK (mutation_lease_fence IS NULL OR mutation_lease_fence > 0),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'MUTATE_REPOSITORY', 'PUBLISH_GIT_REFERENCE', 'MUTATE_GITHUB', 'MUTATE_OUTLINE',
    'APPLY_APPROVAL_TRANSITION', 'EXECUTE_LOCAL_GATE', 'DISCARD_RETAINED_WORK'
  )),
  operation_digest TEXT NOT NULL UNIQUE
    CHECK (length(operation_digest) = 64 AND operation_digest NOT GLOB '*[^a-f0-9]*'),
  resource_id TEXT CHECK (resource_id IS NULL OR length(resource_id) BETWEEN 1 AND 256),
  expected_revision TEXT CHECK (expected_revision IS NULL OR length(expected_revision) BETWEEN 1 AND 256),
  connector_id TEXT CHECK (connector_id IS NULL OR length(connector_id) BETWEEN 1 AND 128),
  connector_epoch INTEGER CHECK (connector_epoch IS NULL OR connector_epoch > 0),
  connector_scope_id TEXT CHECK (connector_scope_id IS NULL OR length(connector_scope_id) BETWEEN 1 AND 128),
  connector_scope_revision INTEGER CHECK (connector_scope_revision IS NULL OR connector_scope_revision > 0),
  connector_operation TEXT CHECK (connector_operation IS NULL OR length(connector_operation) BETWEEN 1 AND 64),
  action_digest TEXT CHECK (
    action_digest IS NULL OR (length(action_digest) = 64 AND action_digest NOT GLOB '*[^a-f0-9]*')
  ),
  state TEXT NOT NULL CHECK (state IN ('ISSUED', 'CONSUMED', 'REVOKED', 'EXPIRED')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at BETWEEN issued_at AND expires_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CHECK (state != 'ISSUED' OR (consumed_at IS NULL AND revoked_at IS NULL)),
  CHECK (state != 'CONSUMED' OR (consumed_at IS NOT NULL AND revoked_at IS NULL)),
  CHECK (state != 'REVOKED' OR revoked_at IS NOT NULL),
  CHECK (
    operation_kind NOT IN ('MUTATE_GITHUB', 'MUTATE_OUTLINE')
    OR (connector_id IS NOT NULL AND connector_epoch IS NOT NULL
      AND connector_scope_id IS NOT NULL AND connector_scope_revision IS NOT NULL
      AND connector_operation IS NOT NULL AND action_digest IS NOT NULL)
  )
) STRICT;

CREATE INDEX operation_authorizations_session_state
  ON operation_authorizations(session_id, state, expires_at);

CREATE TRIGGER operation_authorization_claims_immutable
BEFORE UPDATE OF
  id, session_id, session_fence, mutation_lease_fence, operation_kind, operation_digest,
  resource_id, expected_revision, connector_id, connector_epoch, connector_scope_id,
  connector_scope_revision, connector_operation, action_digest, issued_at, expires_at
ON operation_authorizations
BEGIN
  SELECT RAISE(ABORT, 'OPERATION_AUTHORIZATION_CLAIMS_IMMUTABLE');
END;

CREATE TABLE run_lifecycle_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'ATTEMPT_AUTHORIZED', 'ATTEMPT_STARTED', 'ATTEMPT_LOST', 'CHECKPOINTED',
    'RESULT_RECORDED', 'CANCELLATION_REQUESTED', 'COMPLETED', 'FAILED', 'CANCELLED', 'REVOKED'
  )),
  from_state TEXT NOT NULL CHECK (from_state IN ('QUEUED', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  to_state TEXT NOT NULL CHECK (to_state IN ('QUEUED', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  reason_code TEXT CHECK (
    reason_code IS NULL OR (
      length(reason_code) BETWEEN 1 AND 64 AND reason_code NOT GLOB '*[^A-Z0-9_]'
    )
  ),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('MEMBER', 'SCHEDULER', 'RUNNER')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  UNIQUE (run_id, sequence)
) STRICT;

CREATE TRIGGER run_lifecycle_event_immutable
BEFORE UPDATE ON run_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'RUN_LIFECYCLE_EVENT_IMMUTABLE');
END;

CREATE TABLE attempt_lifecycle_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'ACKNOWLEDGED', 'PROCESS_STARTED', 'PROCESS_EXITED', 'FAILED_TO_START',
    'TERMINATION_REQUESTED', 'CANCELLED', 'TIMED_OUT', 'LOST'
  )),
  from_state TEXT NOT NULL CHECK (from_state IN (
    'PENDING', 'STARTING', 'RUNNING', 'EXITED', 'FAILED_TO_START', 'CANCELLED', 'TIMED_OUT', 'LOST'
  )),
  to_state TEXT NOT NULL CHECK (to_state IN (
    'PENDING', 'STARTING', 'RUNNING', 'EXITED', 'FAILED_TO_START', 'CANCELLED', 'TIMED_OUT', 'LOST'
  )),
  reason_code TEXT CHECK (
    reason_code IS NULL OR (
      length(reason_code) BETWEEN 1 AND 64 AND reason_code NOT GLOB '*[^A-Z0-9_]'
    )
  ),
  exit_code INTEGER,
  signal TEXT CHECK (signal IS NULL OR length(signal) BETWEEN 1 AND 32),
  correlation_id TEXT CHECK (correlation_id IS NULL OR length(correlation_id) BETWEEN 1 AND 128),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  UNIQUE (attempt_id, sequence)
) STRICT;

CREATE TRIGGER attempt_lifecycle_event_immutable
BEFORE UPDATE ON attempt_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'ATTEMPT_LIFECYCLE_EVENT_IMMUTABLE');
END;

CREATE TABLE run_checkpoints (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id),
  reason TEXT NOT NULL CHECK (reason IN ('HUMAN_INPUT', 'RECOVERY', 'MUTATION_LEASE_EXPIRED', 'CANCELLATION')),
  requested_action TEXT NOT NULL CHECK (requested_action IN ('RESPOND', 'RESUME', 'ADOPT_FOLLOW_UP', 'NONE')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 2048),
  runner_id TEXT NOT NULL REFERENCES runners(id),
  worktree_identity TEXT NOT NULL CHECK (length(worktree_identity) BETWEEN 1 AND 128),
  current_commit TEXT CHECK (
    current_commit IS NULL OR (length(current_commit) IN (40, 64) AND current_commit NOT GLOB '*[^a-f0-9]*')
  ),
  published_remote_identity TEXT CHECK (
    published_remote_identity IS NULL OR length(published_remote_identity) BETWEEN 1 AND 128
  ),
  published_remote_ref TEXT CHECK (
    published_remote_ref IS NULL OR length(published_remote_ref) BETWEEN 1 AND 255
  ),
  published_commit TEXT CHECK (
    published_commit IS NULL OR (length(published_commit) IN (40, 64) AND published_commit NOT GLOB '*[^a-f0-9]*')
  ),
  published_verified_at INTEGER CHECK (published_verified_at IS NULL OR published_verified_at >= 0),
  resume_guidance TEXT NOT NULL CHECK (length(resume_guidance) BETWEEN 1 AND 2048),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (
    (published_remote_identity IS NULL AND published_remote_ref IS NULL AND published_commit IS NULL AND published_verified_at IS NULL)
    OR (published_remote_identity IS NOT NULL AND published_remote_ref IS NOT NULL AND published_commit IS NOT NULL AND published_verified_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX run_checkpoints_run_created
  ON run_checkpoints(run_id, created_at);

CREATE TRIGGER run_checkpoint_immutable
BEFORE UPDATE ON run_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'RUN_CHECKPOINT_IMMUTABLE');
END;

CREATE TABLE checkpoint_evidence_links (
  checkpoint_id TEXT NOT NULL REFERENCES run_checkpoints(id),
  evidence_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  PRIMARY KEY (checkpoint_id, evidence_id),
  UNIQUE (checkpoint_id, ordinal)
) STRICT;

CREATE TRIGGER checkpoint_evidence_link_immutable
BEFORE UPDATE ON checkpoint_evidence_links
BEGIN
  SELECT RAISE(ABORT, 'CHECKPOINT_EVIDENCE_LINK_IMMUTABLE');
END;

CREATE TABLE checkpoint_source_revisions (
  checkpoint_id TEXT NOT NULL REFERENCES run_checkpoints(id),
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 256),
  source_revision TEXT NOT NULL CHECK (length(source_revision) BETWEEN 1 AND 128),
  PRIMARY KEY (checkpoint_id, source_key)
) STRICT;

CREATE TRIGGER checkpoint_source_revision_immutable
BEFORE UPDATE ON checkpoint_source_revisions
BEGIN
  SELECT RAISE(ABORT, 'CHECKPOINT_SOURCE_REVISION_IMMUTABLE');
END;

CREATE TABLE checkpoint_responses (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  checkpoint_id TEXT NOT NULL REFERENCES run_checkpoints(id),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('MEMBER', 'SCHEDULER')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  response_kind TEXT NOT NULL CHECK (response_kind IN ('HUMAN_RESPONSE', 'POLICY_DECISION')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 2048),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE INDEX checkpoint_responses_checkpoint_created
  ON checkpoint_responses(checkpoint_id, created_at);

CREATE TRIGGER checkpoint_response_immutable
BEFORE UPDATE ON checkpoint_responses
BEGIN
  SELECT RAISE(ABORT, 'CHECKPOINT_RESPONSE_IMMUTABLE');
END;

CREATE TABLE run_evidence (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  attempt_id TEXT REFERENCES execution_attempts(id),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN (
    'PUBLISHED_GIT_REFERENCE', 'DIFF_STATS', 'CHANGED_PATHS', 'GATE_EVALUATION',
    'VERIFICATION', 'ATTEMPT_OUTCOME', 'CLEANUP'
  )),
  summary TEXT CHECK (summary IS NULL OR length(summary) BETWEEN 1 AND 2048),
  outcome TEXT CHECK (outcome IS NULL OR length(outcome) BETWEEN 1 AND 64),
  repository_revision TEXT CHECK (repository_revision IS NULL OR length(repository_revision) BETWEEN 1 AND 128),
  secondary_revision TEXT CHECK (secondary_revision IS NULL OR length(secondary_revision) BETWEEN 1 AND 128),
  subject_id TEXT CHECK (subject_id IS NULL OR length(subject_id) BETWEEN 1 AND 128),
  gate_key TEXT CHECK (gate_key IS NULL OR length(gate_key) BETWEEN 1 AND 128),
  manifest_fingerprint TEXT CHECK (
    manifest_fingerprint IS NULL OR (length(manifest_fingerprint) = 64 AND manifest_fingerprint NOT GLOB '*[^a-f0-9]*')
  ),
  remote_identity TEXT CHECK (remote_identity IS NULL OR length(remote_identity) BETWEEN 1 AND 128),
  remote_ref TEXT CHECK (remote_ref IS NULL OR length(remote_ref) BETWEEN 1 AND 255),
  observed_at INTEGER CHECK (observed_at IS NULL OR observed_at >= 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000),
  files_changed INTEGER CHECK (files_changed IS NULL OR files_changed BETWEEN 0 AND 100000),
  additions INTEGER CHECK (additions IS NULL OR additions BETWEEN 0 AND 10000000),
  deletions INTEGER CHECK (deletions IS NULL OR deletions BETWEEN 0 AND 10000000),
  dirty INTEGER CHECK (dirty IS NULL OR dirty IN (0, 1)),
  truncated INTEGER CHECK (truncated IS NULL OR truncated IN (0, 1)),
  tracked_clean INTEGER CHECK (tracked_clean IS NULL OR tracked_clean IN (0, 1)),
  untracked_clean INTEGER CHECK (untracked_clean IS NULL OR untracked_clean IN (0, 1)),
  published_commit TEXT CHECK (
    published_commit IS NULL OR (length(published_commit) IN (40, 64) AND published_commit NOT GLOB '*[^a-f0-9]*')
  ),
  evidence_revision INTEGER CHECK (evidence_revision IS NULL OR evidence_revision > 0),
  evidence_digest TEXT NOT NULL UNIQUE
    CHECK (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE INDEX run_evidence_run_created
  ON run_evidence(run_id, created_at, id);

CREATE TRIGGER run_evidence_immutable
BEFORE UPDATE ON run_evidence
BEGIN
  SELECT RAISE(ABORT, 'RUN_EVIDENCE_IMMUTABLE');
END;

CREATE TABLE run_evidence_changed_paths (
  evidence_id TEXT NOT NULL REFERENCES run_evidence(id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  repository_relative_path TEXT NOT NULL CHECK (
    length(repository_relative_path) BETWEEN 1 AND 1024
    AND substr(repository_relative_path, 1, 1) != '/'
    AND repository_relative_path NOT LIKE '../%'
    AND repository_relative_path NOT LIKE '%/../%'
  ),
  PRIMARY KEY (evidence_id, ordinal),
  UNIQUE (evidence_id, repository_relative_path)
) STRICT;

CREATE TRIGGER run_evidence_changed_path_immutable
BEFORE UPDATE ON run_evidence_changed_paths
BEGIN
  SELECT RAISE(ABORT, 'RUN_EVIDENCE_CHANGED_PATH_IMMUTABLE');
END;

CREATE TABLE run_results (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES execution_attempts(id),
  result_kind TEXT NOT NULL CHECK (result_kind IN ('DELIVERED', 'NO_CHANGES', 'BLOCKED', 'ESCALATED')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 2048),
  reason_code TEXT CHECK (
    reason_code IS NULL OR (
      length(reason_code) BETWEEN 1 AND 64 AND reason_code NOT GLOB '*[^A-Z0-9_]'
    )
  ),
  requested_action TEXT CHECK (
    requested_action IS NULL OR requested_action IN ('RESPOND', 'RESUME', 'SELECT_RUNNER', 'ADOPT_FOLLOW_UP', 'NONE')
  ),
  evidence_set_digest TEXT NOT NULL
    CHECK (length(evidence_set_digest) = 64 AND evidence_set_digest NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (
    result_kind NOT IN ('BLOCKED', 'ESCALATED')
    OR (reason_code IS NOT NULL AND requested_action IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER run_result_immutable
BEFORE UPDATE ON run_results
BEGIN
  SELECT RAISE(ABORT, 'RUN_RESULT_IMMUTABLE');
END;

CREATE TABLE run_result_evidence_links (
  result_id TEXT NOT NULL REFERENCES run_results(id),
  evidence_id TEXT NOT NULL REFERENCES run_evidence(id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  PRIMARY KEY (result_id, evidence_id),
  UNIQUE (result_id, ordinal)
) STRICT;

CREATE TRIGGER run_result_evidence_link_immutable
BEFORE UPDATE ON run_result_evidence_links
BEGIN
  SELECT RAISE(ABORT, 'RUN_RESULT_EVIDENCE_LINK_IMMUTABLE');
END;

CREATE TABLE authority_revocations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('MEMBER', 'CONNECTOR', 'RUNNER', 'EXPOSURE', 'REPOSITORY', 'RUN')),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 256),
  source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('MEMBER', 'SCHEDULER', 'RUNNER')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  disposition TEXT NOT NULL CHECK (disposition IN ('DENY_FUTURE', 'REQUEST_TERMINATION', 'REDUCE_AUTHORITY')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (source_kind, source_id, source_epoch)
) STRICT;

CREATE INDEX authority_revocations_source_epoch
  ON authority_revocations(source_kind, source_id, source_epoch);

CREATE TRIGGER authority_revocation_immutable
BEFORE UPDATE ON authority_revocations
BEGIN
  SELECT RAISE(ABORT, 'AUTHORITY_REVOCATION_IMMUTABLE');
END;

CREATE TABLE authority_termination_intents (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  attempt_id TEXT REFERENCES execution_attempts(id),
  intent_kind TEXT NOT NULL CHECK (intent_kind IN (
    'CHECKPOINT_AND_TERMINATE', 'CAPABILITY_UPDATE', 'CANCEL_ATTEMPT', 'RECONCILE_ATTEMPT'
  )),
  reason_code TEXT NOT NULL CHECK (
    length(reason_code) BETWEEN 1 AND 64 AND reason_code NOT GLOB '*[^A-Z0-9_]'
  ),
  semantic_digest TEXT NOT NULL UNIQUE
    CHECK (length(semantic_digest) = 64 AND semantic_digest NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'DISPATCHED', 'ACKNOWLEDGED', 'FAILED')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  dispatched_at INTEGER CHECK (dispatched_at IS NULL OR dispatched_at >= created_at),
  acknowledged_at INTEGER CHECK (
    acknowledged_at IS NULL OR (dispatched_at IS NOT NULL AND acknowledged_at >= dispatched_at)
  ),
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR (
      length(last_error_code) BETWEEN 1 AND 64 AND last_error_code NOT GLOB '*[^A-Z0-9_]'
    )
  )
) STRICT;

CREATE INDEX pending_authority_termination_intents
  ON authority_termination_intents(created_at) WHERE state IN ('PENDING', 'DISPATCHED');

CREATE TRIGGER authority_termination_intent_identity_immutable
BEFORE UPDATE OF id, run_id, attempt_id, intent_kind, reason_code, semantic_digest, created_at
ON authority_termination_intents
BEGIN
  SELECT RAISE(ABORT, 'AUTHORITY_TERMINATION_INTENT_IDENTITY_IMMUTABLE');
END;

CREATE TABLE accepted_runner_events (
  runner_id TEXT NOT NULL REFERENCES runners(id),
  semantic_event_id TEXT NOT NULL CHECK (length(semantic_event_id) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  attempt_id TEXT REFERENCES execution_attempts(id),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'ATTEMPT_EVENT', 'CHECKPOINT', 'EVIDENCE', 'RUN_RESULT', 'TERMINATION_CONFIRMATION'
  )),
  local_sequence INTEGER NOT NULL CHECK (local_sequence > 0),
  predecessor_event_id TEXT CHECK (predecessor_event_id IS NULL OR length(predecessor_event_id) BETWEEN 1 AND 128),
  input_hash TEXT NOT NULL
    CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^a-f0-9]*'),
  committed_result_id TEXT NOT NULL CHECK (length(committed_result_id) BETWEEN 1 AND 128),
  disposition TEXT NOT NULL CHECK (disposition IN ('APPLIED', 'REPLAYED', 'REJECTED')),
  accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0),
  PRIMARY KEY (runner_id, semantic_event_id),
  UNIQUE (runner_id, run_id, local_sequence)
) STRICT;

CREATE INDEX accepted_runner_events_attempt_sequence
  ON accepted_runner_events(attempt_id, local_sequence);

CREATE TRIGGER accepted_runner_event_immutable
BEFORE UPDATE ON accepted_runner_events
BEGIN
  SELECT RAISE(ABORT, 'ACCEPTED_RUNNER_EVENT_IMMUTABLE');
END;

CREATE TABLE accepted_event_ack_outbox (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  runner_id TEXT NOT NULL,
  semantic_event_id TEXT NOT NULL,
  result_reference TEXT NOT NULL CHECK (length(result_reference) BETWEEN 1 AND 128),
  semantic_digest TEXT NOT NULL UNIQUE
    CHECK (length(semantic_digest) = 64 AND semantic_digest NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'DISPATCHED', 'ACKNOWLEDGED', 'FAILED')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 1000),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  dispatched_at INTEGER CHECK (dispatched_at IS NULL OR dispatched_at >= created_at),
  acknowledged_at INTEGER CHECK (
    acknowledged_at IS NULL OR (dispatched_at IS NOT NULL AND acknowledged_at >= dispatched_at)
  ),
  FOREIGN KEY (runner_id, semantic_event_id)
    REFERENCES accepted_runner_events(runner_id, semantic_event_id)
) STRICT;

CREATE INDEX pending_accepted_event_ack_outbox
  ON accepted_event_ack_outbox(runner_id, created_at) WHERE state IN ('PENDING', 'DISPATCHED');

CREATE TRIGGER accepted_event_ack_identity_immutable
BEFORE UPDATE OF
  id, runner_id, semantic_event_id, result_reference, semantic_digest, created_at
ON accepted_event_ack_outbox
BEGIN
  SELECT RAISE(ABORT, 'ACCEPTED_EVENT_ACK_IDENTITY_IMMUTABLE');
END;

CREATE TABLE deployment_authority_state (
  deployment_id TEXT PRIMARY KEY REFERENCES deployments(id),
  singleton INTEGER NOT NULL UNIQUE CHECK (singleton = 1),
  authority_incarnation TEXT NOT NULL UNIQUE CHECK (length(authority_incarnation) BETWEEN 32 AND 128),
  restore_state TEXT NOT NULL CHECK (restore_state IN ('READY', 'STAGING', 'PROMOTING', 'FAILED')),
  restore_operation_id TEXT CHECK (restore_operation_id IS NULL OR length(restore_operation_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE TABLE credential_wrapping_keys (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  credential_class TEXT NOT NULL CHECK (credential_class IN ('PROVIDER', 'MEMBER_OAUTH', 'DEVICE_REFRESH')),
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  wrapping_key_id TEXT NOT NULL CHECK (length(wrapping_key_id) BETWEEN 1 AND 128),
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES_256_GCM'),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  wrapped_key BLOB NOT NULL CHECK (length(wrapped_key) BETWEEN 32 AND 4096),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'ACTIVE', 'RETIRED', 'REVOKED')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  activated_at INTEGER CHECK (activated_at IS NULL OR activated_at >= created_at),
  retired_at INTEGER CHECK (retired_at IS NULL OR retired_at >= created_at),
  UNIQUE (credential_class, key_version)
) STRICT;

CREATE UNIQUE INDEX active_credential_wrapping_key
  ON credential_wrapping_keys(credential_class) WHERE state = 'ACTIVE';

CREATE TRIGGER credential_wrapping_key_material_immutable
BEFORE UPDATE OF
  id, credential_class, key_version, wrapping_key_id, algorithm, nonce, wrapped_key, auth_tag, created_at
ON credential_wrapping_keys
BEGIN
  SELECT RAISE(ABORT, 'CREDENTIAL_WRAPPING_KEY_MATERIAL_IMMUTABLE');
END;

CREATE TABLE credential_key_rotations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  credential_class TEXT NOT NULL CHECK (credential_class IN ('PROVIDER', 'MEMBER_OAUTH', 'DEVICE_REFRESH')),
  from_key_version INTEGER NOT NULL CHECK (from_key_version > 0),
  to_key_version INTEGER NOT NULL CHECK (to_key_version > from_key_version),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'REWRAPPING', 'VERIFYING', 'COMPLETED', 'FAILED')),
  last_credential_id TEXT CHECK (last_credential_id IS NULL OR length(last_credential_id) BETWEEN 1 AND 128),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= created_at),
  UNIQUE (credential_class, from_key_version, to_key_version)
) STRICT;

CREATE INDEX active_credential_key_rotations
  ON credential_key_rotations(credential_class, state)
  WHERE state IN ('PENDING', 'REWRAPPING', 'VERIFYING');

CREATE TABLE backup_records (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  format TEXT NOT NULL CHECK (format = '2COLLAB_BACKUP_V1'),
  manifest_version INTEGER NOT NULL CHECK (manifest_version = 1),
  deployment_fingerprint TEXT NOT NULL CHECK (length(deployment_fingerprint) = 64),
  source_authority_incarnation TEXT NOT NULL CHECK (length(source_authority_incarnation) BETWEEN 32 AND 128),
  product_version TEXT NOT NULL CHECK (length(product_version) BETWEEN 1 AND 64),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  migration_digest TEXT NOT NULL CHECK (length(migration_digest) = 64),
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES_256_GCM_CHUNKED_V1'),
  key_id TEXT NOT NULL CHECK (length(key_id) BETWEEN 1 AND 128),
  chunk_bytes INTEGER NOT NULL CHECK (chunk_bytes BETWEEN 4096 AND 16777216),
  plaintext_bytes INTEGER NOT NULL CHECK (plaintext_bytes >= 0),
  plaintext_sha256 TEXT NOT NULL CHECK (length(plaintext_sha256) = 64),
  ciphertext_bytes INTEGER NOT NULL CHECK (ciphertext_bytes > 0),
  ciphertext_sha256 TEXT NOT NULL CHECK (length(ciphertext_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('CREATING', 'VERIFIED', 'FAILED', 'RETAINED', 'DELETED')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  verified_at INTEGER CHECK (verified_at IS NULL OR verified_at >= created_at),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= created_at)
) STRICT;

CREATE INDEX verified_backups_created
  ON backup_records(created_at) WHERE state IN ('VERIFIED', 'RETAINED');

CREATE TRIGGER backup_manifest_immutable
BEFORE UPDATE OF
  id, format, manifest_version, deployment_fingerprint, source_authority_incarnation,
  product_version, schema_version, migration_digest, algorithm, key_id, chunk_bytes,
  plaintext_bytes, plaintext_sha256, ciphertext_bytes, ciphertext_sha256, created_at
ON backup_records
BEGIN
  SELECT RAISE(ABORT, 'BACKUP_MANIFEST_IMMUTABLE');
END;

CREATE TABLE restore_operations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  backup_id TEXT NOT NULL REFERENCES backup_records(id),
  target_authority_incarnation TEXT NOT NULL UNIQUE CHECK (length(target_authority_incarnation) BETWEEN 32 AND 128),
  state TEXT NOT NULL CHECK (state IN ('VERIFYING', 'STAGING', 'INVALIDATING', 'PROMOTING', 'COMPLETED', 'FAILED')),
  source_schema_version INTEGER NOT NULL CHECK (source_schema_version > 0),
  target_schema_version INTEGER NOT NULL CHECK (target_schema_version >= source_schema_version),
  staged_database_digest TEXT CHECK (staged_database_digest IS NULL OR length(staged_database_digest) = 64),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= created_at)
) STRICT;

CREATE INDEX active_restore_operations
  ON restore_operations(state) WHERE state != 'COMPLETED' AND state != 'FAILED';

CREATE TABLE backup_retention_state (
  deployment_id TEXT PRIMARY KEY REFERENCES deployments(id),
  maximum_verified_backups INTEGER NOT NULL CHECK (maximum_verified_backups BETWEEN 1 AND 1000),
  maximum_age_seconds INTEGER NOT NULL CHECK (maximum_age_seconds > 0),
  minimum_usable_backups INTEGER NOT NULL CHECK (
    minimum_usable_backups BETWEEN 1 AND maximum_verified_backups
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

CREATE TABLE personal_run_presets (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_member_id TEXT NOT NULL REFERENCES members(id),
  project_id TEXT REFERENCES projects(id),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120 AND display_name = trim(display_name)),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'ARCHIVED')),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= created_at),
  CHECK (state != 'ARCHIVED' OR archived_at IS NOT NULL)
) STRICT;

CREATE INDEX personal_run_presets_owner_state
  ON personal_run_presets(owner_member_id, state, updated_at);

CREATE TRIGGER personal_run_preset_identity_immutable
BEFORE UPDATE OF id, owner_member_id, project_id, created_at ON personal_run_presets
BEGIN
  SELECT RAISE(ABORT, 'PERSONAL_RUN_PRESET_IDENTITY_IMMUTABLE');
END;

CREATE TABLE personal_run_preset_versions (
  preset_id TEXT NOT NULL REFERENCES personal_run_presets(id),
  version INTEGER NOT NULL CHECK (version > 0),
  derived_template_id TEXT CHECK (derived_template_id IS NULL OR length(derived_template_id) BETWEEN 1 AND 128),
  derived_template_version INTEGER CHECK (derived_template_version IS NULL OR derived_template_version > 0),
  runner_id TEXT NOT NULL REFERENCES runners(id),
  runner_epoch INTEGER NOT NULL CHECK (runner_epoch > 0),
  mapping_revision INTEGER NOT NULL CHECK (mapping_revision > 0),
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  profile_fingerprint TEXT NOT NULL
    CHECK (length(profile_fingerprint) = 64 AND profile_fingerprint NOT GLOB '*[^a-f0-9]*'),
  host TEXT NOT NULL CHECK (host IN ('NATIVE', 'ORCA')),
  interaction TEXT NOT NULL CHECK (interaction IN ('HEADLESS', 'INTERACTIVE')),
  repository_mode TEXT NOT NULL CHECK (repository_mode IN ('MUTATING', 'INSPECT_ONLY')),
  repository_assurance TEXT NOT NULL CHECK (repository_assurance IN ('ADVISORY', 'ENFORCED')),
  execution_policy TEXT NOT NULL CHECK (execution_policy IN ('ONCE', 'MANAGED_LOOP')),
  maximum_attempts INTEGER NOT NULL CHECK (maximum_attempts BETWEEN 1 AND 1000),
  deadline_seconds INTEGER NOT NULL CHECK (deadline_seconds > 0),
  managed_loop_max_iterations INTEGER CHECK (
    managed_loop_max_iterations IS NULL OR managed_loop_max_iterations BETWEEN 1 AND maximum_attempts
  ),
  managed_loop_cadence_seconds INTEGER CHECK (
    managed_loop_cadence_seconds IS NULL OR managed_loop_cadence_seconds > 0
  ),
  stop_policy_digest TEXT CHECK (
    stop_policy_digest IS NULL OR (length(stop_policy_digest) = 64 AND stop_policy_digest NOT GLOB '*[^a-f0-9]*')
  ),
  unknown_grace_seconds INTEGER CHECK (unknown_grace_seconds IS NULL OR unknown_grace_seconds > 0),
  unknown_backoff_initial_seconds INTEGER CHECK (
    unknown_backoff_initial_seconds IS NULL OR unknown_backoff_initial_seconds > 0
  ),
  unknown_backoff_max_seconds INTEGER CHECK (
    unknown_backoff_max_seconds IS NULL OR unknown_backoff_max_seconds >= unknown_backoff_initial_seconds
  ),
  context_recipe_id TEXT CHECK (context_recipe_id IS NULL OR length(context_recipe_id) BETWEEN 1 AND 128),
  context_recipe_version INTEGER CHECK (context_recipe_version IS NULL OR context_recipe_version > 0),
  reusable_goal_template TEXT CHECK (
    reusable_goal_template IS NULL OR length(reusable_goal_template) BETWEEN 1 AND 16384
  ),
  reusable_instruction_template TEXT CHECK (
    reusable_instruction_template IS NULL OR length(reusable_instruction_template) BETWEEN 1 AND 16384
  ),
  personal_addendum TEXT CHECK (personal_addendum IS NULL OR length(personal_addendum) BETWEEN 1 AND 16384),
  configuration_digest TEXT NOT NULL
    CHECK (length(configuration_digest) = 64 AND configuration_digest NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (preset_id, version),
  CHECK ((derived_template_id IS NULL) = (derived_template_version IS NULL)),
  CHECK ((context_recipe_id IS NULL) = (context_recipe_version IS NULL)),
  CHECK (
    (execution_policy = 'ONCE' AND managed_loop_max_iterations IS NULL
      AND managed_loop_cadence_seconds IS NULL AND stop_policy_digest IS NULL
      AND unknown_grace_seconds IS NULL AND unknown_backoff_initial_seconds IS NULL
      AND unknown_backoff_max_seconds IS NULL)
    OR
    (execution_policy = 'MANAGED_LOOP' AND managed_loop_max_iterations IS NOT NULL
      AND managed_loop_cadence_seconds IS NOT NULL AND stop_policy_digest IS NOT NULL
      AND unknown_grace_seconds IS NOT NULL AND unknown_backoff_initial_seconds IS NOT NULL
      AND unknown_backoff_max_seconds IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER personal_run_preset_version_immutable
BEFORE UPDATE ON personal_run_preset_versions
BEGIN
  SELECT RAISE(ABORT, 'PERSONAL_RUN_PRESET_VERSION_IMMUTABLE');
END;

CREATE TRIGGER personal_run_preset_version_delete_denied
BEFORE DELETE ON personal_run_preset_versions
BEGIN
  SELECT RAISE(ABORT, 'PERSONAL_RUN_PRESET_VERSION_DELETE_DENIED');
END;

CREATE TABLE personal_run_preset_gates (
  preset_id TEXT NOT NULL,
  preset_version INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  gate_name TEXT NOT NULL CHECK (
    length(gate_name) BETWEEN 1 AND 120 AND gate_name NOT GLOB '*[^A-Za-z0-9_.:-]*'
  ),
  manifest_fingerprint TEXT NOT NULL CHECK (
    length(manifest_fingerprint) = 64
    AND manifest_fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  PRIMARY KEY (preset_id, preset_version, gate_name),
  UNIQUE (preset_id, preset_version, ordinal),
  FOREIGN KEY (preset_id, preset_version)
    REFERENCES personal_run_preset_versions(preset_id, version)
) STRICT;

CREATE TRIGGER personal_run_preset_gate_immutable
BEFORE UPDATE ON personal_run_preset_gates
BEGIN
  SELECT RAISE(ABORT, 'PERSONAL_RUN_PRESET_GATE_IMMUTABLE');
END;

CREATE TRIGGER personal_run_preset_gate_delete_denied
BEFORE DELETE ON personal_run_preset_gates
BEGIN
  SELECT RAISE(ABORT, 'PERSONAL_RUN_PRESET_GATE_DELETE_DENIED');
END;

CREATE TABLE personal_run_preset_stop_nodes (
  preset_id TEXT NOT NULL,
  preset_version INTEGER NOT NULL,
  node_id TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 128),
  parent_node_id TEXT CHECK (parent_node_id IS NULL OR length(parent_node_id) BETWEEN 1 AND 128),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  node_kind TEXT NOT NULL CHECK (node_kind IN (
    'ALL', 'ANY', 'NOT', 'GITHUB_ISSUE_STATE', 'PULL_REQUEST_STATE', 'CHECKS_STATE',
    'UNRESOLVED_MAJOR_REVIEWS', 'APPROVAL_STATE', 'AGENT_OUTCOME', 'CONSECUTIVE_MATCHES'
  )),
  subject_id TEXT CHECK (subject_id IS NULL OR length(subject_id) BETWEEN 1 AND 256),
  expected_value TEXT CHECK (expected_value IS NULL OR length(expected_value) BETWEEN 1 AND 128),
  match_count INTEGER CHECK (match_count IS NULL OR match_count > 0),
  PRIMARY KEY (preset_id, preset_version, node_id),
  UNIQUE (preset_id, preset_version, parent_node_id, ordinal),
  FOREIGN KEY (preset_id, preset_version)
    REFERENCES personal_run_preset_versions(preset_id, version),
  CHECK (node_kind != 'NOT' OR ordinal = 1),
  CHECK (node_kind != 'CONSECUTIVE_MATCHES' OR match_count IS NOT NULL)
) STRICT;

CREATE TRIGGER personal_run_preset_stop_node_immutable
BEFORE UPDATE ON personal_run_preset_stop_nodes
BEGIN
  SELECT RAISE(ABORT, 'PERSONAL_RUN_PRESET_STOP_NODE_IMMUTABLE');
END;

CREATE TRIGGER personal_run_preset_stop_node_delete_denied
BEFORE DELETE ON personal_run_preset_stop_nodes
BEGIN
  SELECT RAISE(ABORT, 'PERSONAL_RUN_PRESET_STOP_NODE_DELETE_DENIED');
END;

CREATE TABLE project_personal_preset_defaults (
  owner_member_id TEXT NOT NULL REFERENCES members(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  preset_id TEXT NOT NULL REFERENCES personal_run_presets(id),
  preset_version INTEGER NOT NULL CHECK (preset_version > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (owner_member_id, project_id),
  FOREIGN KEY (preset_id, preset_version) REFERENCES personal_run_preset_versions(preset_id, version)
) STRICT;

CREATE TABLE context_recipes (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL REFERENCES projects(id),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120 AND display_name = trim(display_name)),
  current_version INTEGER NOT NULL CHECK (current_version > 0),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'ARCHIVED')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= created_at)
) STRICT;

CREATE INDEX context_recipes_project_state
  ON context_recipes(project_id, state, updated_at);

CREATE TRIGGER context_recipe_identity_immutable
BEFORE UPDATE OF id, project_id, created_at ON context_recipes
BEGIN
  SELECT RAISE(ABORT, 'CONTEXT_RECIPE_IDENTITY_IMMUTABLE');
END;

CREATE TABLE context_recipe_versions (
  recipe_id TEXT NOT NULL REFERENCES context_recipes(id),
  version INTEGER NOT NULL CHECK (version > 0),
  include_goal INTEGER NOT NULL CHECK (include_goal = 1),
  include_coordination INTEGER NOT NULL CHECK (include_coordination IN (0, 1)),
  include_sources INTEGER NOT NULL CHECK (include_sources IN (0, 1)),
  include_repository INTEGER NOT NULL CHECK (include_repository IN (0, 1)),
  include_predecessor_evidence INTEGER NOT NULL CHECK (include_predecessor_evidence IN (0, 1)),
  maximum_references INTEGER NOT NULL CHECK (maximum_references BETWEEN 1 AND 1000),
  maximum_preview_bytes INTEGER NOT NULL CHECK (maximum_preview_bytes BETWEEN 0 AND 1048576),
  freshness_seconds INTEGER NOT NULL CHECK (freshness_seconds > 0),
  predecessor_policy TEXT NOT NULL CHECK (predecessor_policy IN ('NONE', 'LATEST_CHECKPOINT', 'VERIFIED_EVIDENCE')),
  recipe_digest TEXT NOT NULL
    CHECK (length(recipe_digest) = 64 AND recipe_digest NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (recipe_id, version)
) STRICT;

CREATE TRIGGER context_recipe_version_immutable
BEFORE UPDATE ON context_recipe_versions
BEGIN
  SELECT RAISE(ABORT, 'CONTEXT_RECIPE_VERSION_IMMUTABLE');
END;

CREATE TRIGGER context_recipe_version_delete_denied
BEFORE DELETE ON context_recipe_versions
BEGIN
  SELECT RAISE(ABORT, 'CONTEXT_RECIPE_VERSION_DELETE_DENIED');
END;

CREATE TABLE context_recipe_category_limits (
  recipe_id TEXT NOT NULL,
  recipe_version INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'COORDINATION', 'SOURCE', 'REPOSITORY', 'INSTRUCTION', 'PUBLISHED_GIT_REFERENCE',
    'CHECKPOINT', 'EVIDENCE', 'GATE'
  )),
  maximum_references INTEGER NOT NULL CHECK (maximum_references BETWEEN 0 AND 1000),
  PRIMARY KEY (recipe_id, recipe_version, category),
  FOREIGN KEY (recipe_id, recipe_version)
    REFERENCES context_recipe_versions(recipe_id, version)
) STRICT;

CREATE TRIGGER context_recipe_category_limit_immutable
BEFORE UPDATE ON context_recipe_category_limits
BEGIN
  SELECT RAISE(ABORT, 'CONTEXT_RECIPE_CATEGORY_LIMIT_IMMUTABLE');
END;

CREATE TRIGGER context_recipe_category_limit_delete_denied
BEFORE DELETE ON context_recipe_category_limits
BEGIN
  SELECT RAISE(ABORT, 'CONTEXT_RECIPE_CATEGORY_LIMIT_DELETE_DENIED');
END;

CREATE TABLE run_configuration_snapshots (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id),
  preset_id TEXT CHECK (preset_id IS NULL OR length(preset_id) BETWEEN 1 AND 128),
  preset_version INTEGER CHECK (preset_version IS NULL OR preset_version > 0),
  template_id TEXT CHECK (template_id IS NULL OR length(template_id) BETWEEN 1 AND 128),
  template_version INTEGER CHECK (template_version IS NULL OR template_version > 0),
  context_recipe_id TEXT NOT NULL CHECK (length(context_recipe_id) BETWEEN 1 AND 128),
  context_recipe_version INTEGER NOT NULL CHECK (context_recipe_version > 0),
  personal_addendum TEXT CHECK (personal_addendum IS NULL OR length(personal_addendum) BETWEEN 1 AND 16384),
  authored_run_input TEXT CHECK (authored_run_input IS NULL OR length(authored_run_input) BETWEEN 1 AND 16384),
  effective_configuration_json TEXT NOT NULL CHECK (
    json_valid(effective_configuration_json)
    AND json_type(effective_configuration_json) = 'object'
    AND length(cast(effective_configuration_json AS BLOB)) <= 65536
  ),
  effective_configuration_digest TEXT NOT NULL
    CHECK (length(effective_configuration_digest) = 64 AND effective_configuration_digest NOT GLOB '*[^a-f0-9]*'),
  assembly_digest TEXT NOT NULL
    CHECK (length(assembly_digest) = 64 AND assembly_digest NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK ((preset_id IS NULL) = (preset_version IS NULL)),
  CHECK ((template_id IS NULL) = (template_version IS NULL))
) STRICT;

CREATE TRIGGER run_configuration_snapshot_immutable
BEFORE UPDATE ON run_configuration_snapshots
BEGIN
  SELECT RAISE(ABORT, 'RUN_CONFIGURATION_SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER run_configuration_snapshot_delete_denied
BEFORE DELETE ON run_configuration_snapshots
BEGIN
  SELECT RAISE(ABORT, 'RUN_CONFIGURATION_SNAPSHOT_DELETE_DENIED');
END;

CREATE TABLE context_bootstrap_envelopes (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id),
  recipe_id TEXT NOT NULL CHECK (length(recipe_id) BETWEEN 1 AND 128),
  recipe_version INTEGER NOT NULL CHECK (recipe_version > 0),
  reference_count INTEGER NOT NULL CHECK (reference_count BETWEEN 0 AND 1000),
  preview_bytes INTEGER NOT NULL CHECK (preview_bytes BETWEEN 0 AND 1048576),
  envelope_digest TEXT NOT NULL UNIQUE
    CHECK (length(envelope_digest) = 64 AND envelope_digest NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TRIGGER context_bootstrap_envelope_immutable
BEFORE UPDATE ON context_bootstrap_envelopes
BEGIN
  SELECT RAISE(ABORT, 'CONTEXT_BOOTSTRAP_ENVELOPE_IMMUTABLE');
END;

CREATE TRIGGER context_bootstrap_envelope_delete_denied
BEFORE DELETE ON context_bootstrap_envelopes
BEGIN
  SELECT RAISE(ABORT, 'CONTEXT_BOOTSTRAP_ENVELOPE_DELETE_DENIED');
END;

CREATE TABLE context_envelope_references (
  envelope_id TEXT NOT NULL REFERENCES context_bootstrap_envelopes(id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  category TEXT NOT NULL CHECK (category IN (
    'COORDINATION', 'SOURCE', 'REPOSITORY', 'INSTRUCTION', 'PUBLISHED_GIT_REFERENCE',
    'CHECKPOINT', 'EVIDENCE', 'GATE'
  )),
  reference_id TEXT NOT NULL CHECK (length(reference_id) BETWEEN 1 AND 256),
  observed_revision TEXT CHECK (observed_revision IS NULL OR length(observed_revision) BETWEEN 1 AND 128),
  freshness TEXT NOT NULL CHECK (freshness IN ('FRESH', 'STALE', 'UNAVAILABLE', 'FORBIDDEN')),
  omission_reason TEXT CHECK (omission_reason IS NULL OR length(omission_reason) BETWEEN 1 AND 128),
  preview_text TEXT CHECK (preview_text IS NULL OR length(cast(preview_text AS BLOB)) <= 65536),
  preview_digest TEXT CHECK (
    preview_digest IS NULL OR (length(preview_digest) = 64 AND preview_digest NOT GLOB '*[^a-f0-9]*')
  ),
  PRIMARY KEY (envelope_id, ordinal),
  UNIQUE (envelope_id, category, reference_id),
  CHECK ((preview_text IS NULL) = (preview_digest IS NULL))
) STRICT;

CREATE TRIGGER context_envelope_reference_immutable
BEFORE UPDATE ON context_envelope_references
BEGIN
  SELECT RAISE(ABORT, 'CONTEXT_ENVELOPE_REFERENCE_IMMUTABLE');
END;

CREATE TRIGGER context_envelope_reference_delete_denied
BEFORE DELETE ON context_envelope_references
BEGIN
  SELECT RAISE(ABORT, 'CONTEXT_ENVELOPE_REFERENCE_DELETE_DENIED');
END;

CREATE TABLE attempt_usage_eligibility (
  attempt_id TEXT PRIMARY KEY REFERENCES execution_attempts(id),
  runtime_adapter TEXT NOT NULL CHECK (runtime_adapter IN ('CLAUDE', 'CODEX', 'PI', 'OPENCODE')),
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  declared_model TEXT CHECK (declared_model IS NULL OR length(declared_model) BETWEEN 1 AND 128),
  started_at INTEGER CHECK (started_at IS NULL OR started_at >= 0),
  ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= coalesce(started_at, 0)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TRIGGER attempt_usage_eligibility_immutable
BEFORE UPDATE OF
  attempt_id, runtime_adapter, profile_id, profile_version, provider, declared_model, created_at
ON attempt_usage_eligibility
BEGIN
  SELECT RAISE(ABORT, 'ATTEMPT_USAGE_ELIGIBILITY_IMMUTABLE');
END;

CREATE TRIGGER attempt_usage_eligibility_delete_denied
BEFORE DELETE ON attempt_usage_eligibility
BEGIN
  SELECT RAISE(ABORT, 'ATTEMPT_USAGE_ELIGIBILITY_DELETE_DENIED');
END;

CREATE TABLE usage_observations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  attempt_id TEXT NOT NULL REFERENCES attempt_usage_eligibility(attempt_id),
  observation_id TEXT NOT NULL CHECK (length(observation_id) BETWEEN 1 AND 128),
  provider TEXT CHECK (provider IS NULL OR length(provider) BETWEEN 1 AND 64),
  reported_model TEXT CHECK (reported_model IS NULL OR length(reported_model) BETWEEN 1 AND 128),
  metric_category TEXT NOT NULL CHECK (metric_category IN (
    'INPUT_UNITS', 'OUTPUT_UNITS', 'CACHED_INPUT_UNITS', 'REASONING_UNITS', 'TOTAL_UNITS'
  )),
  availability TEXT NOT NULL CHECK (availability IN ('KNOWN', 'UNKNOWN')),
  units INTEGER CHECK (units IS NULL OR units >= 0),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  UNIQUE (attempt_id, observation_id, metric_category),
  CHECK ((availability = 'KNOWN' AND units IS NOT NULL) OR (availability = 'UNKNOWN' AND units IS NULL))
) STRICT;

CREATE INDEX usage_observations_attempt_category
  ON usage_observations(attempt_id, metric_category, observed_at);

CREATE TRIGGER usage_observation_immutable
BEFORE UPDATE ON usage_observations
BEGIN
  SELECT RAISE(ABORT, 'USAGE_OBSERVATION_IMMUTABLE');
END;

CREATE TRIGGER usage_observation_delete_denied
BEFORE DELETE ON usage_observations
BEGIN
  SELECT RAISE(ABORT, 'USAGE_OBSERVATION_DELETE_DENIED');
END;

CREATE TABLE operational_incidents (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  incident_kind TEXT NOT NULL CHECK (incident_kind IN (
    'MIGRATION', 'BACKUP', 'RESTORE', 'KEY_ROTATION', 'RUNNER_LOSS', 'AUTHORITY_REVOCATION'
  )),
  correlation_id TEXT NOT NULL UNIQUE CHECK (length(correlation_id) BETWEEN 1 AND 128),
  subject_id TEXT CHECK (subject_id IS NULL OR length(subject_id) BETWEEN 1 AND 128),
  safe_code TEXT NOT NULL CHECK (
    length(safe_code) BETWEEN 1 AND 64 AND safe_code NOT GLOB '*[^A-Z0-9_]'
  ),
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'RESOLVED')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  resolved_at INTEGER CHECK (resolved_at IS NULL OR resolved_at >= created_at),
  CHECK (state != 'RESOLVED' OR resolved_at IS NOT NULL)
) STRICT;

CREATE INDEX open_operational_incidents
  ON operational_incidents(incident_kind, created_at) WHERE state = 'OPEN';

CREATE TABLE published_git_references (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id),
  repository_id TEXT NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 128),
  remote_identity TEXT NOT NULL CHECK (length(remote_identity) BETWEEN 1 AND 128),
  remote_ref TEXT NOT NULL CHECK (length(remote_ref) BETWEEN 1 AND 255),
  commit_sha TEXT NOT NULL
    CHECK (length(commit_sha) IN (40, 64) AND commit_sha NOT GLOB '*[^a-f0-9]*'),
  verification_digest TEXT NOT NULL UNIQUE
    CHECK (length(verification_digest) = 64 AND verification_digest NOT GLOB '*[^a-f0-9]*'),
  verified_at INTEGER NOT NULL CHECK (verified_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (run_id, remote_identity, remote_ref, commit_sha)
) STRICT;

CREATE INDEX published_git_references_run_verified
  ON published_git_references(run_id, verified_at);

CREATE TRIGGER published_git_reference_immutable
BEFORE UPDATE ON published_git_references
BEGIN
  SELECT RAISE(ABORT, 'PUBLISHED_GIT_REFERENCE_IMMUTABLE');
END;

CREATE TRIGGER published_git_reference_delete_denied
BEFORE DELETE ON published_git_references
BEGIN
  SELECT RAISE(ABORT, 'PUBLISHED_GIT_REFERENCE_DELETE_DENIED');
END;

CREATE TABLE retained_local_work_projections (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  attempt_id TEXT REFERENCES execution_attempts(id),
  runner_id TEXT NOT NULL REFERENCES runners(id),
  observation_revision INTEGER NOT NULL CHECK (observation_revision > 0),
  observation_digest TEXT NOT NULL
    CHECK (length(observation_digest) = 64 AND observation_digest NOT GLOB '*[^a-f0-9]*'),
  head_commit TEXT NOT NULL
    CHECK (length(head_commit) IN (40, 64) AND head_commit NOT GLOB '*[^a-f0-9]*'),
  retention_reason TEXT NOT NULL CHECK (retention_reason IN (
    'RUN_NOT_TERMINAL', 'ACTIVE_ATTEMPT', 'TRACKED_CHANGES', 'UNTRACKED_FILES',
    'UNPUBLISHED_HEAD', 'REMOTE_UNAVAILABLE', 'HEAD_CHANGED', 'CLEANUP_FAILED', 'AUTHORITY_UNAVAILABLE'
  )),
  tracked_change_count INTEGER NOT NULL CHECK (tracked_change_count >= 0),
  untracked_change_count INTEGER NOT NULL CHECK (untracked_change_count >= 0),
  changed_paths_truncated INTEGER NOT NULL CHECK (changed_paths_truncated IN (0, 1)),
  disk_bytes INTEGER NOT NULL CHECK (disk_bytes >= 0),
  publish_state TEXT NOT NULL CHECK (publish_state IN ('UNPUBLISHED', 'PUBLISHED', 'UNKNOWN')),
  published_reference_id TEXT REFERENCES published_git_references(id),
  state TEXT NOT NULL CHECK (state IN ('RETAINED', 'PUBLISHED', 'DISCARDED', 'REMOVED')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= observed_at),
  UNIQUE (id, observation_revision),
  CHECK (publish_state != 'PUBLISHED' OR published_reference_id IS NOT NULL)
) STRICT;

CREATE INDEX retained_local_work_runner_state
  ON retained_local_work_projections(runner_id, state, updated_at);

CREATE TRIGGER retained_local_work_identity_immutable
BEFORE UPDATE OF id, run_id, attempt_id, runner_id, observed_at
ON retained_local_work_projections
BEGIN
  SELECT RAISE(ABORT, 'RETAINED_LOCAL_WORK_IDENTITY_IMMUTABLE');
END;

CREATE TABLE retained_local_work_changed_paths (
  retained_work_id TEXT NOT NULL REFERENCES retained_local_work_projections(id),
  observation_revision INTEGER NOT NULL CHECK (observation_revision > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  repository_relative_path TEXT NOT NULL CHECK (
    length(repository_relative_path) BETWEEN 1 AND 1024
    AND substr(repository_relative_path, 1, 1) != '/'
    AND repository_relative_path NOT LIKE '../%'
    AND repository_relative_path NOT LIKE '%/../%'
  ),
  PRIMARY KEY (retained_work_id, observation_revision, ordinal),
  FOREIGN KEY (retained_work_id, observation_revision)
    REFERENCES retained_local_work_projections(id, observation_revision)
) STRICT;

CREATE TRIGGER retained_local_work_changed_path_immutable
BEFORE UPDATE ON retained_local_work_changed_paths
BEGIN
  SELECT RAISE(ABORT, 'RETAINED_LOCAL_WORK_CHANGED_PATH_IMMUTABLE');
END;

INSERT INTO schema_migrations(version, applied_at) VALUES (5, unixepoch());
