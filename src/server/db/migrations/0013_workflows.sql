CREATE TABLE team_run_template_versions (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  template_key TEXT NOT NULL CHECK(length(template_key) BETWEEN 1 AND 128),
  version INTEGER NOT NULL CHECK(version > 0),
  project_id TEXT,
  definition_json TEXT NOT NULL,
  semantic_hash TEXT NOT NULL CHECK(length(semantic_hash) = 64),
  published_by_member_id TEXT NOT NULL,
  published_at INTEGER NOT NULL CHECK(published_at >= 0),
  archived_at INTEGER CHECK(archived_at >= published_at),
  UNIQUE(template_key, version),
  UNIQUE(template_key, semantic_hash)
) STRICT;

CREATE TABLE team_workflow_template_versions (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  template_key TEXT NOT NULL CHECK(length(template_key) BETWEEN 1 AND 128),
  version INTEGER NOT NULL CHECK(version > 0),
  definition_json TEXT NOT NULL,
  semantic_hash TEXT NOT NULL CHECK(length(semantic_hash) = 64),
  published_by_member_id TEXT NOT NULL,
  published_at INTEGER NOT NULL CHECK(published_at >= 0),
  UNIQUE(template_key, version),
  UNIQUE(template_key, semantic_hash)
) STRICT;

CREATE TABLE workflow_canvas_layouts (
  workflow_template_version_id TEXT NOT NULL REFERENCES team_workflow_template_versions(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  layout_json TEXT NOT NULL,
  layout_hash TEXT NOT NULL CHECK(length(layout_hash) = 64),
  saved_by_member_id TEXT NOT NULL,
  saved_at INTEGER NOT NULL CHECK(saved_at >= 0),
  PRIMARY KEY(workflow_template_version_id, revision)
) STRICT;

CREATE TABLE workflow_drafts (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  template_key TEXT NOT NULL CHECK(length(template_key) BETWEEN 1 AND 128),
  revision INTEGER NOT NULL CHECK(revision > 0),
  definition_json TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  updated_by_member_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
) STRICT;

CREATE TABLE workflow_draft_history (
  draft_id TEXT NOT NULL REFERENCES workflow_drafts(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  definition_json TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  authored_by_member_id TEXT NOT NULL,
  authored_at INTEGER NOT NULL CHECK(authored_at >= 0),
  PRIMARY KEY(draft_id, revision)
) STRICT;

CREATE TABLE personal_workflow_presets (
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  owner_member_id TEXT NOT NULL CHECK(length(owner_member_id) BETWEEN 1 AND 128),
  version INTEGER NOT NULL CHECK(version > 0),
  workflow_template_version_id TEXT NOT NULL REFERENCES team_workflow_template_versions(id)
    CHECK(length(workflow_template_version_id) BETWEEN 1 AND 128),
  bindings_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(id, version),
  UNIQUE(owner_member_id, id, version)
) STRICT;

CREATE TABLE template_registry_writes (
  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  actor_member_id TEXT NOT NULL CHECK(length(actor_member_id) BETWEEN 1 AND 128),
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('PUBLISH_RUN_TEMPLATE','PUBLISH_WORKFLOW_TEMPLATE','BIND_WORKFLOW_PRESET','SAVE_WORKFLOW_DRAFT','DUPLICATE_WORKFLOW_DRAFT')),
  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64),
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;

CREATE TRIGGER team_run_template_version_identity_immutable
BEFORE UPDATE OF id, template_key, version, project_id, definition_json, semantic_hash,
  published_by_member_id, published_at ON team_run_template_versions
BEGIN
  SELECT RAISE(ABORT, 'TEAM_RUN_TEMPLATE_VERSION_IMMUTABLE');
END;

CREATE TRIGGER team_run_template_version_delete_denied
BEFORE DELETE ON team_run_template_versions
BEGIN
  SELECT RAISE(ABORT, 'TEAM_RUN_TEMPLATE_VERSION_DELETE_DENIED');
END;

CREATE TRIGGER team_workflow_template_version_immutable
BEFORE UPDATE ON team_workflow_template_versions
BEGIN
  SELECT RAISE(ABORT, 'TEAM_WORKFLOW_TEMPLATE_VERSION_IMMUTABLE');
END;

CREATE TRIGGER team_workflow_template_version_delete_denied
BEFORE DELETE ON team_workflow_template_versions
BEGIN
  SELECT RAISE(ABORT, 'TEAM_WORKFLOW_TEMPLATE_VERSION_DELETE_DENIED');
END;

CREATE TRIGGER personal_workflow_preset_version_immutable
BEFORE UPDATE ON personal_workflow_presets
BEGIN
  SELECT RAISE(ABORT, 'PERSONAL_WORKFLOW_PRESET_VERSION_IMMUTABLE');
END;

CREATE TRIGGER personal_workflow_preset_version_delete_denied
BEFORE DELETE ON personal_workflow_presets
BEGIN
  SELECT RAISE(ABORT, 'PERSONAL_WORKFLOW_PRESET_VERSION_DELETE_DENIED');
END;

CREATE TRIGGER workflow_canvas_layout_immutable
BEFORE UPDATE ON workflow_canvas_layouts
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_CANVAS_LAYOUT_IMMUTABLE');
END;

CREATE TRIGGER workflow_canvas_layout_delete_denied
BEFORE DELETE ON workflow_canvas_layouts
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_CANVAS_LAYOUT_DELETE_DENIED');
END;

CREATE TRIGGER workflow_draft_history_immutable
BEFORE UPDATE ON workflow_draft_history
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_DRAFT_HISTORY_IMMUTABLE');
END;

CREATE TRIGGER workflow_draft_history_delete_denied
BEFORE DELETE ON workflow_draft_history
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_DRAFT_HISTORY_DELETE_DENIED');
END;

INSERT INTO schema_migrations(version, applied_at)
VALUES (13, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
