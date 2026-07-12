DROP TRIGGER local_semantic_outbox_immutable_update;

ALTER TABLE local_semantic_outbox RENAME TO local_semantic_outbox_v4;

CREATE TABLE local_semantic_outbox (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 128),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 128),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'OPERATION_ACKNOWLEDGEMENT', 'ATTEMPT_EVENT', 'CHECKPOINT', 'EVIDENCE',
    'RUN_RESULT', 'GATE_EVENT'
  )),
  priority TEXT NOT NULL CHECK (priority IN ('NORMAL', 'CRITICAL')),
  body_digest TEXT NOT NULL CHECK (
    length(body_digest) = 64 AND body_digest NOT GLOB '*[^0-9a-f]*'
  ),
  body_json TEXT NOT NULL CHECK (
    json_valid(body_json) AND length(CAST(body_json AS BLOB)) <= 65536
  ),
  byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 1 AND 65536),
  local_sequence INTEGER NOT NULL CHECK (local_sequence > 0),
  predecessor_event_id TEXT UNIQUE
    REFERENCES local_semantic_outbox(event_id)
    CHECK (predecessor_event_id IS NULL OR length(predecessor_event_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (
    state IN ('PENDING', 'IN_FLIGHT', 'ACKNOWLEDGED', 'PERMANENTLY_REJECTED')
  ),
  rejection_code TEXT CHECK (
    rejection_code IS NULL OR (
      length(rejection_code) BETWEEN 1 AND 64 AND rejection_code NOT GLOB '*[^A-Z0-9_]'
    )
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  acknowledged_at INTEGER CHECK (acknowledged_at IS NULL OR acknowledged_at >= created_at),
  CHECK (
    (state = 'PERMANENTLY_REJECTED' AND rejection_code IS NOT NULL AND acknowledged_at IS NOT NULL)
    OR (state = 'ACKNOWLEDGED' AND rejection_code IS NULL AND acknowledged_at IS NOT NULL)
    OR (state IN ('PENDING', 'IN_FLIGHT') AND rejection_code IS NULL AND acknowledged_at IS NULL)
  ),
  UNIQUE (run_id, local_sequence)
) STRICT;

INSERT INTO local_semantic_outbox(
  event_id, run_id, event_kind, priority, body_digest, body_json, byte_count,
  local_sequence, predecessor_event_id, state, created_at, updated_at
)
SELECT
  event_id,
  json_extract(body_json, '$.payload.runId'),
  json_extract(body_json, '$.kind'),
  CASE
    WHEN json_extract(body_json, '$.kind') IN ('CHECKPOINT', 'RUN_RESULT')
      OR json_extract(body_json, '$.payload.event.kind') IN (
        'PROCESS_EXITED', 'FAILED_TO_START', 'CANCELLED', 'TIMED_OUT', 'LOST'
      )
    THEN 'CRITICAL'
    ELSE 'NORMAL'
  END,
  body_digest,
  body_json,
  byte_count,
  row_number() OVER (PARTITION BY json_extract(body_json, '$.payload.runId') ORDER BY created_at, event_id),
  lag(event_id) OVER (PARTITION BY json_extract(body_json, '$.payload.runId') ORDER BY created_at, event_id),
  'PENDING',
  created_at,
  created_at
FROM local_semantic_outbox_v4
WHERE json_extract(body_json, '$.kind') IN (
  'OPERATION_ACKNOWLEDGEMENT', 'ATTEMPT_EVENT', 'CHECKPOINT', 'EVIDENCE',
  'RUN_RESULT', 'GATE_EVENT'
)
ORDER BY created_at, event_id;

DROP TABLE local_semantic_outbox_v4;

CREATE INDEX local_semantic_outbox_ready
  ON local_semantic_outbox(state, local_sequence);

CREATE INDEX local_semantic_outbox_run_sequence
  ON local_semantic_outbox(run_id, local_sequence);

CREATE TRIGGER local_semantic_outbox_identity_immutable
BEFORE UPDATE OF
  event_id, run_id, event_kind, priority, body_digest, body_json, byte_count,
  local_sequence, predecessor_event_id, created_at
ON local_semantic_outbox
BEGIN
  SELECT RAISE(ABORT, 'LOCAL_SEMANTIC_OUTBOX_IDENTITY_IMMUTABLE');
END;

CREATE TABLE local_continuity_cache (
  cache_key TEXT PRIMARY KEY CHECK (length(cache_key) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 128),
  fact_kind TEXT NOT NULL CHECK (
    fact_kind IN ('SOURCE_REVISION', 'CONTEXT_REFERENCE', 'POLICY_FACT')
  ),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 256),
  source_revision TEXT NOT NULL CHECK (length(source_revision) BETWEEN 1 AND 128),
  value_code TEXT NOT NULL CHECK (
    length(value_code) BETWEEN 1 AND 64 AND value_code GLOB '[A-Z]*'
    AND value_code NOT GLOB '*[^A-Z0-9_]'
  ),
  provenance_id TEXT NOT NULL CHECK (length(provenance_id) BETWEEN 1 AND 128),
  byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 1 AND 16384),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  expires_at INTEGER NOT NULL CHECK (
    expires_at > observed_at AND expires_at <= observed_at + 604800
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE INDEX local_continuity_cache_run_expiry
  ON local_continuity_cache(run_id, expires_at);

CREATE INDEX local_continuity_cache_expiry
  ON local_continuity_cache(expires_at);

INSERT INTO schema_migrations(version, applied_at)
VALUES (6, CAST(strftime('%s', 'now') AS INTEGER));
