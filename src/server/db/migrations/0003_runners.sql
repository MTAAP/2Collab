CREATE TABLE runners (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128)
    CHECK (id GLOB '[A-Za-z0-9]*' AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  owner_member_id TEXT NOT NULL REFERENCES members(id),
  runner_epoch INTEGER NOT NULL CHECK (runner_epoch > 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  dispatch_audience TEXT NOT NULL DEFAULT 'OWNER_ONLY'
    CHECK (dispatch_audience IN ('OWNER_ONLY', 'TEAM')),
  maximum_concurrent_attempts INTEGER NOT NULL DEFAULT 1
    CHECK (maximum_concurrent_attempts BETWEEN 1 AND 32),
  security_policy_version INTEGER NOT NULL DEFAULT 1 CHECK (security_policy_version > 0),
  security_digest TEXT NOT NULL CHECK (length(security_digest) = 64 AND security_digest NOT GLOB '*[^a-f0-9]*'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  last_heartbeat_at INTEGER CHECK (last_heartbeat_at IS NULL OR last_heartbeat_at >= created_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at)
) STRICT;

CREATE TRIGGER runners_owner_immutable
BEFORE UPDATE OF owner_member_id ON runners
WHEN NEW.owner_member_id != OLD.owner_member_id
BEGIN
  SELECT RAISE(ABORT, 'RUNNER_OWNER_IMMUTABLE');
END;

CREATE TABLE runner_pairings (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128)
    CHECK (id GLOB '[A-Za-z0-9]*' AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  pairing_secret_hash BLOB NOT NULL UNIQUE CHECK (length(pairing_secret_hash) = 32),
  device_member_id TEXT NOT NULL REFERENCES members(id),
  device_member_authority_epoch INTEGER NOT NULL CHECK (device_member_authority_epoch > 0),
  device_family_id TEXT NOT NULL CHECK (length(device_family_id) BETWEEN 1 AND 128),
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
  device_key_thumbprint TEXT NOT NULL CHECK (length(device_key_thumbprint) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'CONFIRMED', 'CONSUMED', 'REVOKED')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 600),
  confirmed_at INTEGER CHECK (confirmed_at IS NULL OR confirmed_at BETWEEN created_at AND expires_at),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at)
  ,CHECK (state != 'PENDING' OR (confirmed_at IS NULL AND consumed_at IS NULL))
  ,CHECK (state != 'CONFIRMED' OR (confirmed_at IS NOT NULL AND consumed_at IS NULL))
  ,CHECK (state != 'CONSUMED' OR (confirmed_at IS NOT NULL AND consumed_at IS NOT NULL))
) STRICT;

CREATE TABLE runner_credentials (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128)
    CHECK (id GLOB '[A-Za-z0-9]*' AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  runner_id TEXT NOT NULL REFERENCES runners(id),
  credential_hash BLOB NOT NULL UNIQUE CHECK (length(credential_hash) = 32),
  key_thumbprint TEXT NOT NULL CHECK (length(key_thumbprint) BETWEEN 1 AND 128),
  runner_epoch INTEGER NOT NULL CHECK (runner_epoch > 0),
  member_authority_epoch INTEGER NOT NULL CHECK (member_authority_epoch > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at)
) STRICT;

CREATE UNIQUE INDEX one_active_runner_credential
  ON runner_credentials(runner_id) WHERE revoked_at IS NULL;

CREATE TABLE runner_mapping_versions (
  runner_id TEXT NOT NULL REFERENCES runners(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  local_mapping_id TEXT NOT NULL CHECK (length(local_mapping_id) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  PRIMARY KEY (runner_id, project_id, revision)
) STRICT;

CREATE UNIQUE INDEX one_active_runner_mapping
  ON runner_mapping_versions(runner_id, project_id) WHERE revoked_at IS NULL;

CREATE TRIGGER runner_mapping_facts_immutable
BEFORE UPDATE OF runner_id, project_id, revision, local_mapping_id, created_at ON runner_mapping_versions
BEGIN
  SELECT RAISE(ABORT, 'RUNNER_MAPPING_IMMUTABLE');
END;

CREATE TABLE safe_profile_versions (
  runner_id TEXT NOT NULL REFERENCES runners(id),
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
  version INTEGER NOT NULL CHECK (version > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120 AND display_name = trim(display_name)),
  adapter TEXT NOT NULL CHECK (adapter IN ('CLAUDE', 'CODEX', 'PI', 'OPENCODE')),
  supports_native INTEGER NOT NULL CHECK (supports_native IN (0, 1)),
  supports_orca INTEGER NOT NULL CHECK (supports_orca IN (0, 1)),
  supports_headless INTEGER NOT NULL CHECK (supports_headless IN (0, 1)),
  supports_interactive INTEGER NOT NULL CHECK (supports_interactive IN (0, 1)),
  risk_summary TEXT NOT NULL CHECK (length(risk_summary) BETWEEN 1 AND 240),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (supports_native + supports_orca >= 1),
  CHECK (supports_headless + supports_interactive >= 1),
  PRIMARY KEY (runner_id, profile_id, version),
  UNIQUE (runner_id, profile_id, version, fingerprint)
) STRICT;

CREATE TRIGGER safe_profile_versions_append_only
BEFORE UPDATE ON safe_profile_versions
BEGIN
  SELECT RAISE(ABORT, 'RUNNER_PROFILE_IMMUTABLE');
END;

CREATE TABLE runner_exposure_acknowledgements (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  version INTEGER NOT NULL CHECK (version > 0),
  runner_id TEXT NOT NULL REFERENCES runners(id),
  owner_member_id TEXT NOT NULL REFERENCES members(id),
  project_id TEXT NOT NULL,
  mapping_revision INTEGER NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  profile_fingerprint TEXT NOT NULL CHECK (length(profile_fingerprint) = 64),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  security_policy_version INTEGER NOT NULL CHECK (security_policy_version > 0),
  security_digest TEXT NOT NULL CHECK (length(security_digest) = 64),
  acknowledgement_text TEXT NOT NULL CHECK (length(acknowledgement_text) BETWEEN 1 AND 2048),
  acknowledgement_digest TEXT NOT NULL CHECK (length(acknowledgement_digest) = 64),
  accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= accepted_at),
  FOREIGN KEY (runner_id, project_id, mapping_revision)
    REFERENCES runner_mapping_versions(runner_id, project_id, revision),
  FOREIGN KEY (runner_id, profile_id, profile_version, profile_fingerprint)
    REFERENCES safe_profile_versions(runner_id, profile_id, version, fingerprint),
  UNIQUE (
    id, runner_id, owner_member_id, project_id, mapping_revision, profile_id, profile_version,
    profile_fingerprint, policy_revision, security_policy_version, security_digest
  )
) STRICT;

CREATE TRIGGER runner_acknowledgement_content_immutable
BEFORE UPDATE OF version, runner_id, owner_member_id, project_id, mapping_revision, profile_id,
  profile_version, profile_fingerprint, policy_revision, security_policy_version, security_digest,
  acknowledgement_text, acknowledgement_digest, accepted_at
ON runner_exposure_acknowledgements
BEGIN
  SELECT RAISE(ABORT, 'RUNNER_ACKNOWLEDGEMENT_IMMUTABLE');
END;

CREATE TABLE runner_exposures (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  runner_id TEXT NOT NULL REFERENCES runners(id),
  owner_member_id TEXT NOT NULL REFERENCES members(id),
  project_id TEXT NOT NULL,
  mapping_revision INTEGER NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  profile_fingerprint TEXT NOT NULL CHECK (length(profile_fingerprint) = 64),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  security_policy_version INTEGER NOT NULL CHECK (security_policy_version > 0),
  security_digest TEXT NOT NULL CHECK (length(security_digest) = 64),
  acknowledgement_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  FOREIGN KEY (
    acknowledgement_id, runner_id, owner_member_id, project_id, mapping_revision, profile_id,
    profile_version, profile_fingerprint, policy_revision, security_policy_version, security_digest
  ) REFERENCES runner_exposure_acknowledgements(
    id, runner_id, owner_member_id, project_id, mapping_revision, profile_id,
    profile_version, profile_fingerprint, policy_revision, security_policy_version, security_digest
  )
) STRICT;

CREATE UNIQUE INDEX one_active_runner_exposure
  ON runner_exposures(runner_id, project_id, mapping_revision, profile_id, profile_version)
  WHERE revoked_at IS NULL;

CREATE TABLE runner_authority_change_outbox (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  runner_id TEXT NOT NULL REFERENCES runners(id),
  cause TEXT NOT NULL CHECK (cause IN ('DIRECT_REVOCATION', 'MEMBER_OFFBOARDING', 'POLICY_CHANGE')),
  runner_epoch INTEGER NOT NULL CHECK (runner_epoch > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'DISPATCHED', 'FAILED')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  dispatched_at INTEGER CHECK (dispatched_at IS NULL OR dispatched_at >= created_at),
  UNIQUE (runner_id, runner_epoch, cause)
) STRICT;

INSERT INTO schema_migrations(version, applied_at) VALUES (3, unixepoch());
