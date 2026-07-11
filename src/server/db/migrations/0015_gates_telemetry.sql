CREATE TABLE approved_gate_manifests (
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 128),
  base_revision TEXT NOT NULL CHECK(length(base_revision) IN (40, 64) AND base_revision NOT GLOB '*[^a-f0-9]*'),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^a-f0-9]*'),
  approved_by_runner_owner_id TEXT NOT NULL CHECK(length(approved_by_runner_owner_id) BETWEEN 1 AND 128),
  approved_at INTEGER NOT NULL CHECK(approved_at >= 0),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at >= approved_at),
  PRIMARY KEY (project_id, base_revision, fingerprint)
) STRICT;

CREATE TABLE gate_evaluations (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 128),
  repository_revision TEXT NOT NULL CHECK(length(repository_revision) IN (40, 64) AND repository_revision NOT GLOB '*[^a-f0-9]*'),
  gate_key TEXT NOT NULL CHECK(length(gate_key) BETWEEN 1 AND 128),
  manifest_fingerprint TEXT NOT NULL CHECK(length(manifest_fingerprint) = 64 AND manifest_fingerprint NOT GLOB '*[^a-f0-9]*'),
  kind TEXT NOT NULL CHECK (kind IN ('LOCAL_COMMAND','GITHUB_CHECK')),
  state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','PASSED','FAILED','CANCELLED','TIMED_OUT','STALE')),
  evidence_json TEXT NOT NULL CHECK(length(evidence_json) BETWEEN 2 AND 262144 AND json_valid(evidence_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= created_at),
  CHECK((state IN ('PENDING','RUNNING') AND completed_at IS NULL) OR (state IN ('PASSED','FAILED','CANCELLED','TIMED_OUT','STALE') AND completed_at IS NOT NULL))
) STRICT;

CREATE INDEX gate_evaluations_run_revision
  ON gate_evaluations(run_id, repository_revision, gate_key, manifest_fingerprint);

CREATE TABLE managed_loop_state (
  run_id TEXT PRIMARY KEY CHECK(length(run_id) BETWEEN 1 AND 128),
  stop_policy_json TEXT NOT NULL CHECK(json_valid(stop_policy_json)),
  consecutive_state_json TEXT NOT NULL CHECK(json_valid(consecutive_state_json)),
  attempts_created INTEGER NOT NULL CHECK(attempts_created >= 0),
  maximum_attempts INTEGER NOT NULL CHECK(maximum_attempts > 0),
  absolute_deadline_at INTEGER NOT NULL CHECK(absolute_deadline_at > 0),
  next_evaluation_at INTEGER CHECK(next_evaluation_at >= 0),
  CHECK(attempts_created <= maximum_attempts)
) STRICT;

CREATE TABLE managed_loop_events (
  event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL REFERENCES managed_loop_state(run_id),
  attempt_id TEXT CHECK(attempt_id IS NULL OR length(attempt_id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK(kind IN ('FAILED_TO_START','LOST','ATTEMPT_CREATED','REQUEST_NEXT')),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  UNIQUE(run_id, attempt_id, kind)
) STRICT;

CREATE TABLE managed_loop_policy_evaluations (
  evaluation_id TEXT PRIMARY KEY CHECK(length(evaluation_id) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL REFERENCES managed_loop_state(run_id),
  facts_digest TEXT NOT NULL CHECK(length(facts_digest) = 64),
  result TEXT NOT NULL CHECK(result IN ('TRUE','FALSE','UNKNOWN')),
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  evaluated_at INTEGER NOT NULL CHECK(evaluated_at >= 0)
) STRICT;

CREATE TABLE workflow_plan_artifacts (
  workflow_execution_id TEXT NOT NULL CHECK(length(workflow_execution_id) BETWEEN 1 AND 128),
  step_occurrence_id TEXT NOT NULL CHECK(length(step_occurrence_id) BETWEEN 1 AND 128),
  artifact_json TEXT NOT NULL CHECK(json_valid(artifact_json)),
  producer_json TEXT NOT NULL CHECK(json_valid(producer_json)),
  consumer_json TEXT NOT NULL CHECK(json_valid(consumer_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(workflow_execution_id, step_occurrence_id)
) STRICT;

CREATE TABLE workflow_usage_snapshots (
  workflow_execution_id TEXT NOT NULL CHECK(length(workflow_execution_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision > 0),
  coverage_status TEXT NOT NULL CHECK(coverage_status IN ('COMPLETE','PARTIAL')),
  known_attempts INTEGER NOT NULL CHECK(known_attempts >= 0),
  total_attempts INTEGER NOT NULL CHECK(total_attempts >= known_attempts),
  usage_category TEXT NOT NULL CHECK(length(usage_category) BETWEEN 1 AND 64),
  known_input_units INTEGER NOT NULL CHECK(known_input_units >= 0),
  known_output_units INTEGER NOT NULL CHECK(known_output_units >= 0),
  runtime_ms INTEGER NOT NULL CHECK(runtime_ms >= 0),
  gate_ms INTEGER NOT NULL CHECK(gate_ms >= 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(workflow_execution_id, revision)
) STRICT;

INSERT INTO schema_migrations(version, applied_at)
VALUES (15, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
