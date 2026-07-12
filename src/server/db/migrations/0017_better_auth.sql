CREATE TABLE auth_users (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL,
  image TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE auth_sessions (
  id TEXT NOT NULL PRIMARY KEY,
  expiresAt INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('BROWSER', 'CLI_DEVICE')),
  memberAuthorityEpoch INTEGER NOT NULL CHECK(memberAuthorityEpoch >= 0),
  absoluteExpiresAt INTEGER NOT NULL
);

CREATE TABLE auth_accounts (
  id TEXT NOT NULL PRIMARY KEY,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt INTEGER,
  refreshTokenExpiresAt INTEGER,
  scope TEXT,
  password TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE auth_verifications (
  id TEXT NOT NULL PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE auth_passkeys (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT,
  publicKey TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  credentialID TEXT NOT NULL UNIQUE,
  counter INTEGER NOT NULL CHECK(counter >= 0),
  deviceType TEXT NOT NULL,
  backedUp INTEGER NOT NULL CHECK(backedUp IN (0, 1)),
  transports TEXT,
  createdAt INTEGER,
  aaguid TEXT
);

CREATE TABLE auth_device_codes (
  id TEXT NOT NULL PRIMARY KEY,
  deviceCode TEXT NOT NULL UNIQUE,
  userCode TEXT NOT NULL UNIQUE,
  userId TEXT REFERENCES auth_users(id) ON DELETE CASCADE,
  expiresAt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied')),
  lastPolledAt INTEGER,
  pollingInterval INTEGER,
  clientId TEXT,
  scope TEXT
);

CREATE TABLE auth_member_links (
  auth_user_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL UNIQUE REFERENCES members(id),
  authority_epoch_snapshot INTEGER NOT NULL CHECK(authority_epoch_snapshot > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at >= created_at)
) STRICT;

CREATE TABLE auth_registration_tickets (
  id TEXT PRIMARY KEY,
  secret_hash BLOB NOT NULL UNIQUE CHECK(length(secret_hash) = 32),
  auth_user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  intended_member_id TEXT NOT NULL,
  invitation_exchange_session_id TEXT UNIQUE REFERENCES invitation_exchange_sessions(id),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120),
  purpose TEXT NOT NULL CHECK(purpose IN ('BOOTSTRAP', 'HOST_RECOVERY', 'INVITATION')),
  state TEXT NOT NULL CHECK(state IN ('PENDING', 'PASSKEY_VERIFIED', 'CONSUMED')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  consumed_at INTEGER CHECK(consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at),
  CHECK(
    (purpose = 'INVITATION' AND invitation_exchange_session_id IS NOT NULL)
    OR (purpose != 'INVITATION' AND invitation_exchange_session_id IS NULL)
  )
) STRICT;

CREATE INDEX auth_sessions_userId_idx ON auth_sessions(userId);
CREATE INDEX auth_accounts_userId_idx ON auth_accounts(userId);
CREATE INDEX auth_verifications_identifier_idx ON auth_verifications(identifier);
CREATE INDEX auth_passkeys_userId_idx ON auth_passkeys(userId);
CREATE INDEX auth_device_codes_expiry_idx ON auth_device_codes(expiresAt, status);
CREATE INDEX auth_registration_tickets_expiry_idx ON auth_registration_tickets(expires_at, state);

INSERT INTO auth_users(id, name, email, emailVerified, createdAt, updatedAt)
SELECT id, display_name, id || '@identity.invalid', 0, created_at * 1000, created_at * 1000
FROM members;

INSERT INTO auth_member_links(
  auth_user_id, member_id, authority_epoch_snapshot, created_at
)
SELECT id, id, authority_epoch, created_at
FROM members;

-- All legacy browser and device authentication material becomes inert at this boundary.
UPDATE sessions SET revoked_at = COALESCE(revoked_at, CAST(strftime('%s', 'now') AS INTEGER)), revision = revision + 1
WHERE revoked_at IS NULL;
UPDATE device_credential_families
SET revoked_at = COALESCE(revoked_at, CAST(strftime('%s', 'now') AS INTEGER)), revision = revision + 1
WHERE revoked_at IS NULL;
UPDATE passkey_credentials
SET revoked_at = COALESCE(revoked_at, CAST(strftime('%s', 'now') AS INTEGER)), revision = revision + 1
WHERE revoked_at IS NULL;

INSERT INTO schema_migrations(version, applied_at)
VALUES (17, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
