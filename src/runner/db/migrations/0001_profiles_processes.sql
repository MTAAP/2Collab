CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
) STRICT;

CREATE TABLE local_profile_versions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
  version INTEGER NOT NULL CHECK (version > 0),
  adapter TEXT NOT NULL CHECK (adapter IN ('CLAUDE', 'CODEX')),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json) AND length(CAST(definition_json AS BLOB)) <= 131072),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (profile_id, version)
) STRICT;

CREATE TRIGGER local_profile_versions_immutable_update
BEFORE UPDATE ON local_profile_versions
BEGIN
  SELECT RAISE(ABORT, 'LOCAL_PROFILE_VERSION_IMMUTABLE');
END;

CREATE TRIGGER local_profile_versions_immutable_delete
BEFORE DELETE ON local_profile_versions
BEGIN
  SELECT RAISE(ABORT, 'LOCAL_PROFILE_VERSION_IMMUTABLE');
END;

CREATE TABLE local_processes (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) BETWEEN 1 AND 128),
  reservation_id TEXT NOT NULL UNIQUE CHECK (length(reservation_id) BETWEEN 1 AND 128),
  assignment_digest TEXT NOT NULL CHECK (length(assignment_digest) = 64 AND assignment_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('RESERVED', 'STARTED', 'EXITED', 'UNKNOWN')),
  host TEXT CHECK (host IS NULL OR host IN ('NATIVE', 'ORCA')),
  opaque_process_id TEXT CHECK (opaque_process_id IS NULL OR length(opaque_process_id) BETWEEN 1 AND 256),
  interaction TEXT CHECK (interaction IS NULL OR interaction IN ('HEADLESS', 'INTERACTIVE')),
  assurance TEXT CHECK (assurance IS NULL OR assurance = 'ADVISORY'),
  last_disposition TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK ((state = 'RESERVED' AND host IS NULL AND opaque_process_id IS NULL AND interaction IS NULL AND assurance IS NULL)
      OR (state <> 'RESERVED' AND host IS NOT NULL AND opaque_process_id IS NOT NULL AND interaction IS NOT NULL AND assurance IS NOT NULL))
) STRICT;

CREATE TABLE local_diagnostic_tails (
  correlation_id TEXT PRIMARY KEY CHECK (length(correlation_id) BETWEEN 1 AND 128),
  owner_member_id TEXT NOT NULL CHECK (length(owner_member_id) BETWEEN 1 AND 128),
  interaction TEXT NOT NULL CHECK (interaction IN ('HEADLESS', 'INTERACTIVE')),
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
  byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 0 AND 2097152),
  enabled INTEGER NOT NULL CHECK (enabled = 1),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 86400)
) STRICT;

INSERT INTO schema_migrations(version, applied_at) VALUES (1, CAST(strftime('%s', 'now') AS INTEGER));
