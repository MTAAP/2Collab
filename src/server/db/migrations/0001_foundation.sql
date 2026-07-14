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
  proof_hash BLOB NOT NULL UNIQUE CHECK (length(proof_hash) = 32),
  kind TEXT NOT NULL CHECK (kind IN ('BROWSER', 'RECOVERY', 'DEVICE', 'HOST_RECOVERY')),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  idle_expires_at INTEGER CHECK (idle_expires_at IS NULL OR idle_expires_at >= created_at),
  absolute_expires_at INTEGER CHECK (absolute_expires_at IS NULL OR absolute_expires_at >= created_at),
  csrf_hash BLOB CHECK (csrf_hash IS NULL OR length(csrf_hash) = 32),
  sender_key_thumbprint TEXT,
  member_authority_epoch INTEGER NOT NULL DEFAULT 1 CHECK (member_authority_epoch > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL DEFAULT 0 CHECK (created_at >= 0),
  last_used_at INTEGER CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  rotated_from_id TEXT REFERENCES sessions(id),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (idle_expires_at IS NULL OR absolute_expires_at IS NULL OR idle_expires_at <= absolute_expires_at),
  CHECK (kind != 'BROWSER' OR csrf_hash IS NOT NULL)
) STRICT;

CREATE INDEX sessions_active_member ON sessions(member_id, kind) WHERE revoked_at IS NULL;

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
  passkey_credential_id TEXT REFERENCES passkey_credentials(id),
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
      AND passkey_credential_id IS NULL
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
      AND (passkey_credential_id IS NULL OR member_id IS NOT NULL)
    )
    OR (
      purpose = 'PRIVILEGED_REAUTHENTICATION'
      AND member_id IS NOT NULL
      AND passkey_credential_id IS NULL
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
  credential_class TEXT NOT NULL CHECK (credential_class IN ('PROVIDER', 'MEMBER_OAUTH', 'DEVICE_REFRESH')),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('CONNECTOR', 'MEMBER', 'DEVICE')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  connector_id TEXT NOT NULL CHECK (length(connector_id) BETWEEN 1 AND 128),
  credential_owner_id TEXT NOT NULL CHECK (length(credential_owner_id) BETWEEN 1 AND 128),
  key_id TEXT NOT NULL CHECK (length(key_id) BETWEEN 1 AND 128),
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  algorithm TEXT NOT NULL CHECK (algorithm IN ('AES_256_GCM', 'XCHACHA20_POLY1305')),
  nonce BLOB NOT NULL CHECK (length(nonce) BETWEEN 12 AND 24),
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) BETWEEN 1 AND 65536),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) BETWEEN 16 AND 32),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  UNIQUE (credential_class, connector_id, credential_owner_id)
) STRICT;

CREATE TABLE connector_epochs (
  connector_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  review_state TEXT NOT NULL CHECK (review_state IN ('READY', 'REVIEW_REQUIRED', 'REVOKED')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
) STRICT;

CREATE TABLE oidc_transactions (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  state_hash BLOB NOT NULL UNIQUE CHECK (length(state_hash) = 32),
  nonce_hash BLOB NOT NULL UNIQUE CHECK (length(nonce_hash) = 32),
  redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2048),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 600),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at)
) STRICT;

CREATE TABLE auth_proxy_replays (
  replay_hash BLOB PRIMARY KEY CHECK (length(replay_hash) = 32),
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 512),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE host_recovery_codes (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  code_hash BLOB NOT NULL UNIQUE CHECK (length(code_hash) = 32),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 600),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
) STRICT;

CREATE UNIQUE INDEX one_active_host_recovery_per_owner
  ON host_recovery_codes(member_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE device_authorization_codes (
  id TEXT PRIMARY KEY,
  device_code_hash BLOB NOT NULL UNIQUE CHECK (length(device_code_hash) = 32),
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
  sender_key_thumbprint TEXT NOT NULL CHECK (length(sender_key_thumbprint) BETWEEN 1 AND 256),
  member_id TEXT REFERENCES members(id),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'APPROVED', 'CONSUMED', 'DENIED', 'EXPIRED')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 600),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at)
) STRICT;

CREATE TABLE device_credential_families (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
  sender_key_thumbprint TEXT NOT NULL CHECK (length(sender_key_thumbprint) BETWEEN 1 AND 256),
  current_refresh_hash BLOB NOT NULL UNIQUE CHECK (length(current_refresh_hash) = 32),
  previous_refresh_hash BLOB UNIQUE CHECK (previous_refresh_hash IS NULL OR length(previous_refresh_hash) = 32),
  member_authority_epoch INTEGER NOT NULL DEFAULT 1 CHECK (member_authority_epoch > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  last_used_at INTEGER,
  idle_expires_at INTEGER NOT NULL CHECK (idle_expires_at >= created_at),
  absolute_expires_at INTEGER NOT NULL CHECK (absolute_expires_at >= idle_expires_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at)
) STRICT;

CREATE UNIQUE INDEX one_active_device_family
  ON device_credential_families(member_id, device_id)
  WHERE revoked_at IS NULL;

CREATE TABLE device_access_tokens (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES device_credential_families(id),
  access_hash BLOB NOT NULL UNIQUE CHECK (length(access_hash) = 32),
  sender_key_thumbprint TEXT NOT NULL CHECK (length(sender_key_thumbprint) BETWEEN 1 AND 256),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 600),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at)
) STRICT;

CREATE TABLE dpop_replays (
  proof_id_hash BLOB PRIMARY KEY CHECK (length(proof_id_hash) = 32),
  sender_key_thumbprint TEXT NOT NULL CHECK (length(sender_key_thumbprint) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 600)
) STRICT;

CREATE TABLE connector_scopes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES connector_epochs(connector_id),
  connector_epoch INTEGER NOT NULL CHECK (connector_epoch > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  UNIQUE (project_id, connector_id)
) STRICT;

CREATE TABLE connector_scope_references (
  scope_id TEXT NOT NULL REFERENCES connector_scopes(id) ON DELETE CASCADE,
  reference TEXT NOT NULL CHECK (length(reference) BETWEEN 1 AND 256),
  PRIMARY KEY (scope_id, reference)
) STRICT;

CREATE TABLE connector_scope_operations (
  scope_id TEXT NOT NULL REFERENCES connector_scopes(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 64 AND operation GLOB '[A-Z]*'),
  PRIMARY KEY (scope_id, operation)
) STRICT;

CREATE TABLE connector_operation_authorizations (
  id TEXT PRIMARY KEY,
  proof_hash BLOB NOT NULL UNIQUE CHECK (length(proof_hash) = 32),
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES connector_epochs(connector_id),
  connector_epoch INTEGER NOT NULL CHECK (connector_epoch > 0),
  scope_revision INTEGER NOT NULL CHECK (scope_revision > 0),
  reference TEXT NOT NULL CHECK (length(reference) BETWEEN 1 AND 256),
  operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 64),
  action_digest TEXT NOT NULL CHECK (length(action_digest) = 64),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('MEMBER', 'ATTEMPT', 'RECONCILER')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('RESERVED', 'CONSUMED', 'REVOKED')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at)
) STRICT;

CREATE TABLE connector_operation_intents (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('MEMBER', 'ATTEMPT')),
  operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 64),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  action_marker TEXT NOT NULL CHECK (length(action_marker) BETWEEN 1 AND 256),
  actor_binding_digest TEXT NOT NULL CHECK (length(actor_binding_digest) = 64),
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES connector_epochs(connector_id),
  connector_epoch INTEGER NOT NULL CHECK (connector_epoch > 0),
  scope_revision INTEGER NOT NULL CHECK (scope_revision > 0),
  reference TEXT NOT NULL CHECK (length(reference) BETWEEN 1 AND 256),
  precondition_kind TEXT NOT NULL CHECK (precondition_kind IN ('ABSENT', 'EXACT_REVISION', 'EXPECTED_MEMBERSHIP')),
  source_revision TEXT CHECK (source_revision IS NULL OR length(source_revision) BETWEEN 1 AND 128),
  comparable_digest TEXT CHECK (comparable_digest IS NULL OR length(comparable_digest) = 64),
  member_key TEXT CHECK (member_key IS NULL OR length(member_key) BETWEEN 1 AND 256),
  expected_present INTEGER CHECK (expected_present IS NULL OR expected_present IN (0, 1)),
  action_digest TEXT NOT NULL CHECK (length(action_digest) = 64),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'PROVIDER_CONFIRMED', 'COMMITTED', 'REQUIRES_REAUTHORIZATION', 'FAILED_PERMANENT')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 32),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  provider_reference TEXT CHECK (provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 256),
  provider_source_revision TEXT CHECK (provider_source_revision IS NULL OR length(provider_source_revision) BETWEEN 1 AND 128),
  provider_comparable_digest TEXT CHECK (provider_comparable_digest IS NULL OR length(provider_comparable_digest) = 64),
  provenance_kind TEXT CHECK (provenance_kind IS NULL OR provenance_kind IN ('WEBHOOK', 'RECONCILIATION', 'MUTATION_CONFIRMATION')),
  provider_actor_id TEXT CHECK (provider_actor_id IS NULL OR length(provider_actor_id) BETWEEN 1 AND 256),
  UNIQUE (actor_id, idempotency_key),
  CHECK (
    (precondition_kind = 'ABSENT' AND source_revision IS NULL AND comparable_digest IS NULL AND member_key IS NULL AND expected_present IS NULL)
    OR (precondition_kind = 'EXACT_REVISION' AND source_revision IS NOT NULL AND comparable_digest IS NOT NULL AND member_key IS NULL AND expected_present IS NULL)
    OR (precondition_kind = 'EXPECTED_MEMBERSHIP' AND source_revision IS NOT NULL AND comparable_digest IS NOT NULL AND member_key IS NOT NULL AND expected_present IS NOT NULL)
  )
) STRICT;

CREATE INDEX connector_operation_intents_recovery
  ON connector_operation_intents(connector_id, connector_epoch, state, action_marker);

CREATE TABLE connector_idempotency (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  result_json TEXT NOT NULL CHECK (length(result_json) BETWEEN 1 AND 65536),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (actor_id, idempotency_key)
) STRICT;

CREATE TABLE connector_projections (
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES connector_epochs(connector_id),
  reference TEXT NOT NULL CHECK (length(reference) BETWEEN 1 AND 256),
  connector_epoch INTEGER NOT NULL CHECK (connector_epoch > 0),
  source_revision TEXT NOT NULL CHECK (length(source_revision) BETWEEN 1 AND 128),
  comparable_digest TEXT NOT NULL CHECK (length(comparable_digest) = 64),
  projection_revision INTEGER NOT NULL CHECK (projection_revision > 0),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  source_updated_at INTEGER CHECK (source_updated_at IS NULL OR source_updated_at >= 0),
  freshness TEXT NOT NULL CHECK (freshness IN ('FRESH', 'STALE', 'UNAVAILABLE', 'REDACTED')),
  provenance_kind TEXT NOT NULL CHECK (provenance_kind IN ('WEBHOOK', 'RECONCILIATION', 'MUTATION_CONFIRMATION')),
  provider_actor_id TEXT CHECK (provider_actor_id IS NULL OR length(provider_actor_id) BETWEEN 1 AND 256),
  projection_json TEXT NOT NULL CHECK (length(projection_json) BETWEEN 1 AND 65536),
  PRIMARY KEY (project_id, connector_id, reference)
) STRICT;

CREATE TABLE source_reconciliation_idempotency (
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES connector_epochs(connector_id),
  connector_epoch INTEGER NOT NULL CHECK (connector_epoch > 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  result_revision INTEGER NOT NULL CHECK (result_revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (project_id, connector_id, idempotency_key)
) STRICT;

CREATE TABLE authority_revocation_outbox (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  member_authority_epoch INTEGER NOT NULL CHECK (member_authority_epoch > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'DISPATCHED', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  dispatched_at INTEGER CHECK (dispatched_at IS NULL OR dispatched_at >= created_at),
  UNIQUE (member_id, member_authority_epoch)
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
