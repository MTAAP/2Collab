CREATE TABLE workflow_executions (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  coordination_record_id TEXT NOT NULL CHECK(length(coordination_record_id) BETWEEN 1 AND 128),
  coordination_revision INTEGER NOT NULL CHECK(coordination_revision > 0),
  template_version_id TEXT NOT NULL CHECK(length(template_version_id) BETWEEN 1 AND 128),
  preset_version_id TEXT NOT NULL CHECK(length(preset_version_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','WAITING','PAUSED','COMPLETED','FAILED','CANCELLED')),
  current_node_key TEXT,
  snapshot_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  absolute_deadline_at INTEGER NOT NULL CHECK(absolute_deadline_at > 0),
  terminal_reason TEXT CHECK(terminal_reason IS NULL OR length(terminal_reason) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
) STRICT;

CREATE TABLE workflow_step_occurrences (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  workflow_execution_id TEXT NOT NULL REFERENCES workflow_executions(id),
  node_key TEXT NOT NULL CHECK(length(node_key) BETWEEN 1 AND 128),
  occurrence INTEGER NOT NULL CHECK(occurrence > 0),
  agent_run_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('PENDING','LAUNCH_INTENT','RUNNING','TERMINAL','CANCELLED')),
  result_json TEXT,
  UNIQUE(workflow_execution_id, node_key, occurrence)
) STRICT;

CREATE TABLE workflow_launch_intents (
  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  workflow_execution_id TEXT NOT NULL REFERENCES workflow_executions(id),
  step_occurrence_id TEXT NOT NULL UNIQUE REFERENCES workflow_step_occurrences(id),
  workflow_revision INTEGER NOT NULL CHECK(workflow_revision > 0),
  command_json TEXT NOT NULL,
  dispatched_at INTEGER CHECK(dispatched_at >= 0),
  invalidated_reason TEXT CHECK(invalidated_reason IS NULL OR length(invalidated_reason) BETWEEN 1 AND 128)
) STRICT;

CREATE TABLE workflow_event_receipts (
  event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 128),
  workflow_execution_id TEXT NOT NULL REFERENCES workflow_executions(id),
  event_digest TEXT NOT NULL CHECK(length(event_digest) = 64),
  accepted_at INTEGER NOT NULL CHECK(accepted_at >= 0)
) STRICT;

CREATE TABLE workflow_start_receipts (
  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
  workflow_execution_id TEXT NOT NULL UNIQUE REFERENCES workflow_executions(id),
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;

CREATE TABLE workflow_join_states (
  workflow_execution_id TEXT NOT NULL REFERENCES workflow_executions(id),
  join_node_key TEXT NOT NULL CHECK(length(join_node_key) BETWEEN 1 AND 128),
  state_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(workflow_execution_id, join_node_key)
) STRICT;

CREATE TABLE workflow_decisions (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  workflow_execution_id TEXT NOT NULL REFERENCES workflow_executions(id),
  node_key TEXT NOT NULL CHECK(length(node_key) BETWEEN 1 AND 128),
  choice TEXT NOT NULL CHECK(length(choice) BETWEEN 1 AND 128),
  actor_member_id TEXT NOT NULL CHECK(length(actor_member_id) BETWEEN 1 AND 128),
  expected_workflow_revision INTEGER NOT NULL CHECK(expected_workflow_revision > 0),
  decided_at INTEGER NOT NULL CHECK(decided_at >= 0),
  UNIQUE(workflow_execution_id, node_key)
) STRICT;

CREATE TABLE workflow_cancellation_outbox (
  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  workflow_execution_id TEXT NOT NULL REFERENCES workflow_executions(id),
  step_occurrence_id TEXT NOT NULL UNIQUE REFERENCES workflow_step_occurrences(id),
  agent_run_id TEXT NOT NULL CHECK(length(agent_run_id) BETWEEN 1 AND 128),
  requested_at INTEGER CHECK(requested_at >= 0)
) STRICT;

INSERT INTO schema_migrations(version, applied_at)
VALUES (14, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
