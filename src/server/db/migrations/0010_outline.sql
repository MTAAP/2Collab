CREATE TABLE outline_connections (
  connector_id TEXT PRIMARY KEY REFERENCES connector_epochs(connector_id),
  origin TEXT NOT NULL CHECK(length(origin) BETWEEN 8 AND 2048),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 128),
  bot_provider_user_id TEXT NOT NULL CHECK(length(bot_provider_user_id) BETWEEN 1 AND 128),
  bot_credential_id TEXT NOT NULL REFERENCES encrypted_credentials(id),
  oauth_client_id TEXT NOT NULL CHECK(length(oauth_client_id) BETWEEN 1 AND 256),
  oauth_client_secret_credential_id TEXT REFERENCES encrypted_credentials(id),
  oauth_metadata_digest TEXT NOT NULL CHECK(length(oauth_metadata_digest) = 64 AND oauth_metadata_digest NOT GLOB '*[^a-f0-9]*'),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  UNIQUE(origin, workspace_id)
) STRICT;

CREATE TABLE outline_member_oauth_grants (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  connector_id TEXT NOT NULL REFERENCES outline_connections(connector_id),
  member_id TEXT NOT NULL REFERENCES members(id),
  outline_user_id TEXT NOT NULL CHECK(length(outline_user_id) BETWEEN 1 AND 128),
  credential_id TEXT NOT NULL REFERENCES encrypted_credentials(id),
  granted_scope_digest TEXT NOT NULL CHECK(length(granted_scope_digest) = 64 AND granted_scope_digest NOT GLOB '*[^a-f0-9]*'),
  access_expires_at INTEGER NOT NULL CHECK(access_expires_at >= 0),
  refresh_status TEXT NOT NULL CHECK(refresh_status IN ('READY','ROTATING','REAUTHORIZATION_REQUIRED','REVOKED')),
  credential_revision INTEGER NOT NULL CHECK(credential_revision > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  revoked_at INTEGER CHECK(revoked_at >= created_at),
  UNIQUE(connector_id, member_id),
  UNIQUE(connector_id, outline_user_id)
) STRICT;

CREATE TABLE outline_oauth_transactions (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  connector_id TEXT NOT NULL REFERENCES outline_connections(connector_id),
  member_id TEXT NOT NULL REFERENCES members(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  state_hash BLOB NOT NULL UNIQUE CHECK(length(state_hash) = 32),
  redirect_origin_digest TEXT NOT NULL CHECK(length(redirect_origin_digest) = 64 AND redirect_origin_digest NOT GLOB '*[^a-f0-9]*'),
  pkce_challenge TEXT NOT NULL CHECK(length(pkce_challenge) BETWEEN 43 AND 128),
  pkce_method TEXT NOT NULL CHECK(pkce_method = 'S256'),
  verifier_credential_id TEXT NOT NULL REFERENCES encrypted_credentials(id),
  requested_scope_digest TEXT NOT NULL CHECK(length(requested_scope_digest) = 64 AND requested_scope_digest NOT GLOB '*[^a-f0-9]*'),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  consumed_at INTEGER CHECK(consumed_at >= created_at),
  revoked_at INTEGER CHECK(revoked_at >= created_at),
  revision INTEGER NOT NULL CHECK(revision > 0),
  CHECK(expires_at = created_at + 600000)
) STRICT;

CREATE TABLE outline_document_references (
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES outline_connections(connector_id),
  document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 128),
  observed_collection_id TEXT NOT NULL CHECK(length(observed_collection_id) BETWEEN 1 AND 128),
  safe_title TEXT NOT NULL CHECK(length(safe_title) BETWEEN 1 AND 240),
  source_revision TEXT NOT NULL CHECK(length(source_revision) BETWEEN 1 AND 256),
  comparable_digest TEXT NOT NULL CHECK(length(comparable_digest) = 64 AND comparable_digest NOT GLOB '*[^a-f0-9]*'),
  source_updated_at INTEGER CHECK(source_updated_at >= 0),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  freshness TEXT NOT NULL CHECK(freshness IN ('FRESH','STALE','UNAVAILABLE','REDACTED')),
  provenance_kind TEXT NOT NULL CHECK(provenance_kind IN ('SEARCH','READ','MUTATION_CONFIRMATION','RECONCILIATION')),
  provider_actor_id TEXT CHECK(provider_actor_id IS NULL OR length(provider_actor_id) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(project_id, connector_id, document_id)
) STRICT;

CREATE TABLE outline_access_provenance (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES outline_connections(connector_id),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('MEMBER','RUN_ATTEMPT')),
  member_id TEXT REFERENCES members(id),
  run_id TEXT REFERENCES agent_runs(id),
  attempt_id TEXT REFERENCES execution_attempts(id),
  document_id TEXT,
  observed_revision TEXT CHECK(observed_revision IS NULL OR length(observed_revision) BETWEEN 1 AND 256),
  result TEXT NOT NULL CHECK(result IN ('ALLOWED','STALE','UNAVAILABLE','FORBIDDEN','REDACTED')),
  connector_epoch INTEGER NOT NULL CHECK(connector_epoch > 0),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
  correlation_digest TEXT CHECK(correlation_digest IS NULL OR (length(correlation_digest) = 64 AND correlation_digest NOT GLOB '*[^a-f0-9]*')),
  CHECK((actor_kind = 'MEMBER' AND member_id IS NOT NULL AND run_id IS NULL AND attempt_id IS NULL) OR (actor_kind = 'RUN_ATTEMPT' AND member_id IS NULL AND run_id IS NOT NULL AND attempt_id IS NOT NULL)),
  FOREIGN KEY(project_id, connector_id, document_id) REFERENCES outline_document_references(project_id, connector_id, document_id)
) STRICT;

CREATE INDEX outline_access_provenance_actor
  ON outline_access_provenance(project_id, connector_id, actor_kind, occurred_at);

INSERT INTO schema_migrations(version, applied_at)
VALUES (10, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
