PRAGMA defer_foreign_keys = ON;

DROP TRIGGER context_envelope_reference_immutable;
DROP TRIGGER context_envelope_reference_delete_denied;
DROP TRIGGER context_bootstrap_envelope_immutable;
DROP TRIGGER context_bootstrap_envelope_delete_denied;

ALTER TABLE context_envelope_references RENAME TO context_envelope_references_v5;
ALTER TABLE context_bootstrap_envelopes RENAME TO context_bootstrap_envelopes_v5;

CREATE TABLE context_bootstrap_envelopes (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id),
  recipe_id TEXT NOT NULL CHECK (length(recipe_id) BETWEEN 1 AND 128),
  recipe_version INTEGER NOT NULL CHECK (recipe_version > 0),
  reference_count INTEGER NOT NULL CHECK (reference_count BETWEEN 0 AND 1000),
  preview_bytes INTEGER NOT NULL CHECK (preview_bytes BETWEEN 0 AND 1048576),
  envelope_digest TEXT NOT NULL
    CHECK (length(envelope_digest) = 64 AND envelope_digest NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

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

INSERT INTO context_bootstrap_envelopes(
  id, run_id, recipe_id, recipe_version, reference_count, preview_bytes,
  envelope_digest, created_at
)
SELECT id, run_id, recipe_id, recipe_version, reference_count, preview_bytes,
       envelope_digest, created_at
FROM context_bootstrap_envelopes_v5;

INSERT INTO context_envelope_references(
  envelope_id, ordinal, category, reference_id, observed_revision, freshness,
  omission_reason, preview_text, preview_digest
)
SELECT envelope_id, ordinal, category, reference_id, observed_revision, freshness,
       omission_reason, preview_text, preview_digest
FROM context_envelope_references_v5;

DROP TABLE context_envelope_references_v5;
DROP TABLE context_bootstrap_envelopes_v5;

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

CREATE TABLE execution_attempt_causes (
  attempt_id TEXT PRIMARY KEY REFERENCES execution_attempts(id),
  cause_kind TEXT NOT NULL CHECK (cause_kind IN (
    'INITIAL', 'RETRY', 'RESUME', 'MANAGED_LOOP', 'HUMAN_DECISION', 'LEGACY_UNKNOWN'
  )),
  predecessor_attempt_id TEXT REFERENCES execution_attempts(id),
  checkpoint_id TEXT REFERENCES run_checkpoints(id),
  approval_subject_id TEXT CHECK (
    approval_subject_id IS NULL OR length(approval_subject_id) BETWEEN 1 AND 128
  ),
  managed_loop_iteration INTEGER CHECK (
    managed_loop_iteration IS NULL OR managed_loop_iteration > 0
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (
    (cause_kind = 'INITIAL' AND predecessor_attempt_id IS NULL AND checkpoint_id IS NULL
      AND approval_subject_id IS NULL AND managed_loop_iteration IS NULL)
    OR (cause_kind = 'RETRY' AND predecessor_attempt_id IS NOT NULL AND checkpoint_id IS NULL
      AND approval_subject_id IS NULL AND managed_loop_iteration IS NULL)
    OR (cause_kind = 'RESUME' AND predecessor_attempt_id IS NULL AND checkpoint_id IS NOT NULL
      AND approval_subject_id IS NULL AND managed_loop_iteration IS NULL)
    OR (cause_kind = 'MANAGED_LOOP' AND predecessor_attempt_id IS NULL AND checkpoint_id IS NULL
      AND approval_subject_id IS NULL AND managed_loop_iteration IS NOT NULL)
    OR (cause_kind = 'HUMAN_DECISION' AND predecessor_attempt_id IS NULL AND checkpoint_id IS NULL
      AND approval_subject_id IS NOT NULL AND managed_loop_iteration IS NULL)
    OR (cause_kind = 'LEGACY_UNKNOWN' AND predecessor_attempt_id IS NULL AND checkpoint_id IS NULL
      AND approval_subject_id IS NULL AND managed_loop_iteration IS NULL)
  )
) STRICT;

CREATE INDEX execution_attempt_causes_kind
  ON execution_attempt_causes(cause_kind, created_at);

CREATE TRIGGER execution_attempt_cause_immutable
BEFORE UPDATE ON execution_attempt_causes
BEGIN
  SELECT RAISE(ABORT, 'EXECUTION_ATTEMPT_CAUSE_IMMUTABLE');
END;

CREATE TRIGGER execution_attempt_cause_delete_denied
BEFORE DELETE ON execution_attempt_causes
BEGIN
  SELECT RAISE(ABORT, 'EXECUTION_ATTEMPT_CAUSE_DELETE_DENIED');
END;

INSERT INTO execution_attempt_causes(attempt_id, cause_kind, created_at)
SELECT id, CASE WHEN ordinal = 1 THEN 'INITIAL' ELSE 'LEGACY_UNKNOWN' END, created_at
FROM execution_attempts;

INSERT INTO schema_migrations(version, applied_at)
VALUES (6, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
