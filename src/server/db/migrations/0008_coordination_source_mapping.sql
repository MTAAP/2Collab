CREATE TABLE github_source_aliases (
  project_id TEXT NOT NULL REFERENCES projects(id),
  connector_id TEXT NOT NULL REFERENCES github_installations(connector_id),
  provider_alias_kind TEXT NOT NULL CHECK(provider_alias_kind IN ('REPOSITORY_NUMBER','NODE_ID','CANONICAL_URL')),
  provider_alias TEXT NOT NULL CHECK(length(provider_alias) BETWEEN 1 AND 512),
  source_item_id TEXT NOT NULL CHECK(length(source_item_id) BETWEEN 1 AND 256),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  PRIMARY KEY (project_id, connector_id, provider_alias_kind, provider_alias),
  FOREIGN KEY (project_id, connector_id, source_item_id)
    REFERENCES coordination_source_references(project_id, connector_id, source_item_id)
) STRICT;

CREATE TABLE coordination_record_aliases (
  project_id TEXT NOT NULL REFERENCES projects(id),
  alias_record_id TEXT NOT NULL,
  canonical_record_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason = 'AUTHORIZED_COALESCE'),
  actor_member_id TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  CHECK(alias_record_id <> canonical_record_id),
  PRIMARY KEY(project_id, alias_record_id),
  FOREIGN KEY(alias_record_id, project_id) REFERENCES coordination_records(id, project_id),
  FOREIGN KEY(canonical_record_id, project_id) REFERENCES coordination_records(id, project_id)
) STRICT;

CREATE TRIGGER coordination_record_alias_immutable
BEFORE UPDATE ON coordination_record_aliases BEGIN
  SELECT RAISE(ABORT, 'COORDINATION_RECORD_ALIAS_IMMUTABLE');
END;

CREATE TRIGGER coordination_record_alias_no_chain
BEFORE INSERT ON coordination_record_aliases
WHEN EXISTS (
  SELECT 1 FROM coordination_record_aliases
  WHERE project_id = NEW.project_id AND alias_record_id = NEW.canonical_record_id
) OR EXISTS (
  SELECT 1 FROM coordination_record_aliases
  WHERE project_id = NEW.project_id AND canonical_record_id = NEW.alias_record_id
)
BEGIN
  SELECT RAISE(ABORT, 'COORDINATION_ALIAS_CHAIN_DENIED');
END;

INSERT INTO schema_migrations(version, applied_at)
VALUES (8, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
