CREATE TABLE auth_registration_policy (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK(singleton = 1),
  mode TEXT NOT NULL CHECK(mode IN ('CLOSED', 'INVITE_ONLY', 'ALLOWLIST')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_by_member_id TEXT REFERENCES members(id),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
) STRICT;

INSERT INTO auth_registration_policy(
  singleton, mode, revision, updated_by_member_id, created_at, updated_at
) VALUES (1, 'INVITE_ONLY', 1, NULL, unixepoch(), unixepoch());

CREATE TABLE auth_registration_rules (
  id TEXT PRIMARY KEY,
  effect TEXT NOT NULL CHECK(effect IN ('ALLOW', 'DENY')),
  matcher TEXT NOT NULL CHECK(matcher IN ('EMAIL', 'DOMAIN')),
  value TEXT NOT NULL CHECK(length(value) BETWEEN 1 AND 254),
  include_subdomains INTEGER NOT NULL CHECK(include_subdomains IN (0, 1)),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_by_member_id TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at >= created_at),
  CHECK(matcher = 'DOMAIN' OR include_subdomains = 0),
  CHECK(value = lower(value)),
  CHECK(instr(value, ' ') = 0)
) STRICT;

CREATE UNIQUE INDEX one_active_auth_registration_rule
ON auth_registration_rules(effect, matcher, value, include_subdomains)
WHERE revoked_at IS NULL;

CREATE TABLE auth_email_registration_tickets (
  id TEXT PRIMARY KEY,
  secret_hash BLOB NOT NULL UNIQUE CHECK(length(secret_hash) = 32),
  normalized_email TEXT NOT NULL CHECK(length(normalized_email) BETWEEN 3 AND 254),
  auth_user_id TEXT NOT NULL UNIQUE REFERENCES auth_users(id) ON DELETE CASCADE,
  intended_member_id TEXT NOT NULL UNIQUE,
  invitation_exchange_session_id TEXT REFERENCES invitation_exchange_sessions(id),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120),
  authorization_kind TEXT NOT NULL CHECK(authorization_kind IN ('INVITATION', 'ALLOWLIST')),
  policy_revision INTEGER NOT NULL CHECK(policy_revision > 0),
  state TEXT NOT NULL CHECK(state IN ('AUTHORIZED', 'VERIFIED', 'CONSUMED')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  consumed_at INTEGER CHECK(consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at),
  CHECK(normalized_email = lower(normalized_email)),
  CHECK(instr(normalized_email, ' ') = 0),
  CHECK(
    (authorization_kind = 'INVITATION' AND invitation_exchange_session_id IS NOT NULL) OR
    (authorization_kind = 'ALLOWLIST' AND invitation_exchange_session_id IS NULL)
  )
) STRICT;

CREATE INDEX auth_email_registration_ticket_expiry
ON auth_email_registration_tickets(expires_at, state);

CREATE TABLE auth_email_send_windows (
  email_digest BLOB NOT NULL PRIMARY KEY CHECK(length(email_digest) = 32),
  window_started_at INTEGER NOT NULL CHECK(window_started_at >= 0),
  send_count INTEGER NOT NULL CHECK(send_count BETWEEN 1 AND 3),
  updated_at INTEGER NOT NULL CHECK(updated_at >= window_started_at)
) STRICT;

INSERT INTO schema_migrations(version, applied_at)
VALUES (18, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
