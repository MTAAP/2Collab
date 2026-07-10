PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
) STRICT;

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  singleton INTEGER NOT NULL UNIQUE CHECK (singleton = 1),
  team_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'Member' CHECK (length(display_name) BETWEEN 1 AND 120),
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'MEMBER')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  authority_epoch INTEGER NOT NULL DEFAULT 1 CHECK (authority_epoch > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE member_credentials (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL CHECK (kind IN ('OIDC', 'AUTH_PROXY')),
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 512),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  UNIQUE (kind, issuer, subject)
) STRICT;

CREATE TABLE passkey_credentials (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  credential_id TEXT NOT NULL UNIQUE
    CHECK (length(credential_id) BETWEEN 1 AND 1366)
    CHECK (credential_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  public_key BLOB NOT NULL CHECK (length(public_key) BETWEEN 1 AND 8192),
  opaque_user_id BLOB NOT NULL CHECK (length(opaque_user_id) BETWEEN 16 AND 64),
  signature_counter INTEGER NOT NULL CHECK (signature_counter >= 0),
  backup_eligible INTEGER NOT NULL CHECK (backup_eligible IN (0, 1)),
  backup_state INTEGER NOT NULL CHECK (backup_state IN (0, 1) AND backup_state <= backup_eligible),
  device_type TEXT NOT NULL CHECK (device_type IN ('SINGLE_DEVICE', 'MULTI_DEVICE')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  last_used_at INTEGER CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at)
) STRICT;

CREATE TABLE passkey_credential_transports (
  passkey_credential_id TEXT NOT NULL REFERENCES passkey_credentials(id) ON DELETE CASCADE,
  transport TEXT NOT NULL CHECK (transport IN ('BLE', 'CABLE', 'HYBRID', 'INTERNAL', 'NFC', 'SMART_CARD', 'USB')),
  PRIMARY KEY (passkey_credential_id, transport)
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL CHECK (kind IN ('BROWSER', 'RECOVERY', 'DEVICE', 'HOST_RECOVERY')),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  idle_expires_at INTEGER CHECK (idle_expires_at IS NULL OR idle_expires_at >= 0),
  sender_key_thumbprint TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0)
) STRICT;

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  inviter_id TEXT NOT NULL REFERENCES members(id),
  label TEXT,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
) STRICT;

CREATE TABLE invitation_exchange_sessions (
  id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL UNIQUE REFERENCES invitations(id),
  session_hash BLOB NOT NULL UNIQUE CHECK (length(session_hash) = 32),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 900),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
) STRICT;

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('PASSKEY_REGISTRATION', 'PASSKEY_AUTHENTICATION', 'PRIVILEGED_REAUTHENTICATION')),
  challenge_hash BLOB NOT NULL UNIQUE CHECK (length(challenge_hash) = 32),
  member_id TEXT REFERENCES members(id),
  invitation_exchange_session_id TEXT REFERENCES invitation_exchange_sessions(id),
  bootstrap_binding_hash BLOB CHECK (bootstrap_binding_hash IS NULL OR length(bootstrap_binding_hash) = 32),
  rp_id TEXT NOT NULL CHECK (length(rp_id) BETWEEN 1 AND 253),
  expected_origin TEXT NOT NULL CHECK (length(expected_origin) BETWEEN 1 AND 2048),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  CHECK (
    (
      purpose = 'PASSKEY_REGISTRATION'
      AND (
        (member_id IS NOT NULL)
        + (invitation_exchange_session_id IS NOT NULL)
        + (bootstrap_binding_hash IS NOT NULL)
      ) = 1
    )
    OR (
      purpose = 'PASSKEY_AUTHENTICATION'
      AND invitation_exchange_session_id IS NULL
      AND bootstrap_binding_hash IS NULL
    )
    OR (
      purpose = 'PRIVILEGED_REAUTHENTICATION'
      AND member_id IS NOT NULL
      AND invitation_exchange_session_id IS NULL
      AND bootstrap_binding_hash IS NULL
    )
  )
) STRICT;

CREATE TABLE recovery_code_sets (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  generation INTEGER NOT NULL CHECK (generation > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  UNIQUE (member_id, generation)
) STRICT;

CREATE UNIQUE INDEX one_active_recovery_code_set_per_member
  ON recovery_code_sets(member_id)
  WHERE revoked_at IS NULL;

CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  recovery_code_set_id TEXT NOT NULL REFERENCES recovery_code_sets(id) ON DELETE CASCADE,
  code_index INTEGER NOT NULL CHECK (code_index >= 0),
  salt BLOB NOT NULL CHECK (length(salt) BETWEEN 16 AND 64),
  code_hash BLOB NOT NULL CHECK (length(code_hash) BETWEEN 32 AND 128),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  UNIQUE (recovery_code_set_id, code_index),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES deployments(team_id),
  name TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE encrypted_credentials (
  id TEXT PRIMARY KEY,
  credential_class TEXT NOT NULL,
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  auth_tag BLOB NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0)
) STRICT;

CREATE TABLE connector_epochs (
  connector_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  review_state TEXT NOT NULL CHECK (review_state IN ('READY', 'REVIEW_REQUIRED', 'REVOKED'))
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  subject_id TEXT,
  safe_details TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE idempotency_results (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (actor_id, idempotency_key)
) STRICT;

INSERT INTO schema_migrations(version, applied_at) VALUES (1, unixepoch());
