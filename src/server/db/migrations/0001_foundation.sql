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
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'MEMBER')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  authority_epoch INTEGER NOT NULL DEFAULT 1 CHECK (authority_epoch > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE member_credentials (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL CHECK (kind IN ('PASSKEY', 'RECOVERY', 'OIDC', 'AUTH_PROXY')),
  secret_hash BLOB,
  public_data TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0)
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
  token_hash BLOB NOT NULL UNIQUE,
  inviter_id TEXT NOT NULL REFERENCES members(id),
  label TEXT,
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0),
  revision INTEGER NOT NULL CHECK (revision > 0)
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
