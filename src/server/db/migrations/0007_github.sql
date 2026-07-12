CREATE TABLE github_installations (
  connector_id TEXT PRIMARY KEY REFERENCES connector_epochs(connector_id),
  app_id TEXT NOT NULL CHECK(length(app_id) BETWEEN 1 AND 32),
  installation_id TEXT NOT NULL CHECK(installation_id NOT GLOB '*[^0-9]*' AND length(installation_id) BETWEEN 1 AND 32),
  account_id TEXT NOT NULL CHECK(account_id NOT GLOB '*[^0-9]*' AND length(account_id) BETWEEN 1 AND 32),
  account_node_id TEXT NOT NULL CHECK(length(account_node_id) BETWEEN 1 AND 128),
  account_login TEXT NOT NULL CHECK(length(account_login) BETWEEN 1 AND 128),
  private_key_credential_id TEXT NOT NULL REFERENCES encrypted_credentials(id),
  webhook_secret_credential_id TEXT NOT NULL REFERENCES encrypted_credentials(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  UNIQUE(app_id, installation_id)
) STRICT;

CREATE TABLE github_project_connectors (
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES github_installations(connector_id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(project_id, connector_id)
) STRICT;

CREATE TABLE github_selected_repositories (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  repository_id TEXT NOT NULL CHECK(repository_id NOT GLOB '*[^0-9]*' AND length(repository_id) BETWEEN 1 AND 32),
  repository_node_id TEXT NOT NULL CHECK(length(repository_node_id) BETWEEN 1 AND 128),
  owner_login TEXT NOT NULL CHECK(length(owner_login) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
  permission_digest TEXT NOT NULL CHECK(length(permission_digest) = 64 AND permission_digest NOT GLOB '*[^a-f0-9]*'),
  scope_state TEXT NOT NULL CHECK(scope_state IN ('SELECTED','REDACTED','REMOVED')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  PRIMARY KEY (project_id, connector_id, repository_id),
  FOREIGN KEY(project_id, connector_id) REFERENCES github_project_connectors(project_id, connector_id)
) STRICT;

CREATE TABLE github_selected_projects (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  github_project_node_id TEXT NOT NULL CHECK(length(github_project_node_id) BETWEEN 1 AND 128),
  organization_id TEXT NOT NULL CHECK(length(organization_id) BETWEEN 1 AND 128),
  organization_login TEXT NOT NULL CHECK(length(organization_login) BETWEEN 1 AND 128),
  scope_state TEXT NOT NULL CHECK(scope_state IN ('SELECTED','REDACTED','REMOVED')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  PRIMARY KEY (project_id, connector_id, github_project_node_id),
  FOREIGN KEY(project_id, connector_id) REFERENCES github_project_connectors(project_id, connector_id)
) STRICT;

CREATE TABLE github_webhook_deliveries (
  connector_id TEXT NOT NULL REFERENCES github_installations(connector_id),
  hook_id TEXT NOT NULL CHECK(length(hook_id) BETWEEN 1 AND 64),
  delivery_id TEXT NOT NULL CHECK(length(delivery_id) BETWEEN 1 AND 128),
  event_name TEXT NOT NULL CHECK(length(event_name) BETWEEN 1 AND 64),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^a-f0-9]*'),
  ingress_state TEXT NOT NULL CHECK(ingress_state IN ('VERIFIED','CONFLICT','REJECTED')),
  received_at INTEGER NOT NULL CHECK(received_at >= 0),
  applied_at INTEGER CHECK(applied_at >= received_at),
  PRIMARY KEY (connector_id, hook_id, delivery_id)
) STRICT;

CREATE TABLE github_webhook_applications (
  connector_id TEXT NOT NULL,
  hook_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('PENDING','APPLIED','REJECTED_SCOPE','CONFLICT','FAILED_RETRYABLE','FAILED_PERMANENT')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(connector_id, hook_id, delivery_id, project_id),
  FOREIGN KEY(connector_id, hook_id, delivery_id) REFERENCES github_webhook_deliveries(connector_id, hook_id, delivery_id),
  FOREIGN KEY(project_id, connector_id) REFERENCES github_project_connectors(project_id, connector_id)
) STRICT;

CREATE TABLE github_source_projections (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  repository_id TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('REPOSITORY','ISSUE','PULL_REQUEST','MILESTONE','PROJECT','PROJECT_FIELD','PROJECT_ITEM')),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 256),
  projection_schema_version INTEGER NOT NULL CHECK(projection_schema_version > 0),
  projection_json TEXT NOT NULL CHECK(length(cast(projection_json AS BLOB)) <= 65536 AND json_valid(projection_json)),
  projection_hash TEXT NOT NULL CHECK(length(projection_hash) = 64 AND projection_hash NOT GLOB '*[^a-f0-9]*'),
  source_revision TEXT NOT NULL CHECK(length(source_revision) BETWEEN 1 AND 256),
  comparable_digest TEXT NOT NULL CHECK(length(comparable_digest) = 64 AND comparable_digest NOT GLOB '*[^a-f0-9]*'),
  source_updated_at INTEGER CHECK(source_updated_at >= 0),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  provenance_kind TEXT NOT NULL CHECK(provenance_kind IN ('WEBHOOK','RECONCILIATION','MUTATION_CONFIRMATION')),
  freshness TEXT NOT NULL CHECK (freshness IN ('FRESH','STALE','UNAVAILABLE','REDACTED')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  CHECK(freshness <> 'REDACTED' OR projection_json = '{}'),
  CHECK(source_kind NOT IN ('REPOSITORY','ISSUE','PULL_REQUEST','MILESTONE') OR repository_id IS NOT NULL),
  PRIMARY KEY (project_id, connector_id, source_kind, source_id),
  FOREIGN KEY(project_id, connector_id) REFERENCES github_project_connectors(project_id, connector_id),
  FOREIGN KEY(project_id, connector_id, repository_id) REFERENCES github_selected_repositories(project_id, connector_id, repository_id)
) STRICT;

CREATE TABLE github_reconciliation_cursors (
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES github_installations(connector_id),
  resource_family TEXT NOT NULL CHECK(resource_family IN ('REPOSITORIES','ISSUES','PULL_REQUESTS','MILESTONES','PROJECTS','PROJECT_ITEMS')),
  scope_digest TEXT NOT NULL CHECK(length(scope_digest) = 64 AND scope_digest NOT GLOB '*[^a-f0-9]*'),
  connector_epoch INTEGER NOT NULL CHECK(connector_epoch > 0),
  cursor TEXT CHECK(cursor IS NULL OR length(cursor) <= 1024),
  watermark TEXT CHECK(watermark IS NULL OR length(watermark) <= 256),
  status TEXT NOT NULL CHECK(status IN ('IDLE','SCANNING','RATE_LIMITED','FAILED_RETRYABLE')),
  last_complete_at INTEGER CHECK(last_complete_at >= 0),
  not_before INTEGER CHECK(not_before >= 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY (project_id, connector_id, resource_family)
) STRICT;

CREATE INDEX github_webhook_applications_pending
  ON github_webhook_applications(outcome, connector_id, delivery_id);
CREATE INDEX github_reconciliation_due
  ON github_reconciliation_cursors(status, not_before);

INSERT INTO schema_migrations(version, applied_at)
VALUES (7, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
