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

CREATE TABLE coordination_coalescing_permits (
  project_id TEXT NOT NULL REFERENCES projects(id), alias_record_id TEXT NOT NULL,
  canonical_record_id TEXT NOT NULL, actor_member_id TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL CHECK(created_at >= 0), PRIMARY KEY(project_id, alias_record_id),
  FOREIGN KEY(alias_record_id, project_id) REFERENCES coordination_records(id, project_id),
  FOREIGN KEY(canonical_record_id, project_id) REFERENCES coordination_records(id, project_id),
  CHECK(alias_record_id <> canonical_record_id)
) STRICT;

DROP TRIGGER agent_run_provenance_immutable;
CREATE TRIGGER agent_run_provenance_immutable
BEFORE UPDATE OF id, coordination_record_id, project_id, goal, repository_id, repository_mode,
  repository_assurance, base_origin, base_commit, base_branch, intended_branch,
  worktree_identity, effective_configuration_id, effective_configuration_version,
  effective_configuration_digest, dispatcher_kind, dispatcher_id, dispatcher_context_id, created_at
ON agent_runs
WHEN NEW.coordination_record_id = OLD.coordination_record_id OR OLD.state IN ('COMPLETED','FAILED','CANCELLED')
  OR NOT EXISTS (SELECT 1 FROM coordination_coalescing_permits WHERE project_id = OLD.project_id
    AND alias_record_id = OLD.coordination_record_id AND canonical_record_id = NEW.coordination_record_id)
BEGIN SELECT RAISE(ABORT, 'RUN_PROVENANCE_IMMUTABLE'); END;

DROP TRIGGER coordination_source_reference_immutable;
CREATE TRIGGER coordination_source_reference_immutable
BEFORE UPDATE ON coordination_source_references
WHEN NEW.project_id <> OLD.project_id OR NEW.connector_id <> OLD.connector_id
  OR NEW.source_item_id <> OLD.source_item_id OR NEW.source_kind <> OLD.source_kind
  OR NEW.observed_revision <> OLD.observed_revision OR NEW.linked_at <> OLD.linked_at
  OR NOT EXISTS (SELECT 1 FROM coordination_coalescing_permits WHERE project_id = OLD.project_id
    AND alias_record_id = OLD.coordination_record_id AND canonical_record_id = NEW.coordination_record_id)
BEGIN SELECT RAISE(ABORT, 'COORDINATION_SOURCE_IMMUTABLE'); END;

DROP TRIGGER mutation_guard_identity_immutable;
CREATE TRIGGER mutation_guard_identity_immutable
BEFORE UPDATE OF id, coordination_record_id, run_id, reserved_at ON work_item_mutation_guards
WHEN NEW.id <> OLD.id OR NEW.run_id <> OLD.run_id OR NEW.reserved_at <> OLD.reserved_at
  OR NOT EXISTS (SELECT 1 FROM coordination_coalescing_permits p JOIN agent_runs r ON r.id = OLD.run_id
    WHERE p.project_id = r.project_id AND p.alias_record_id = OLD.coordination_record_id
      AND p.canonical_record_id = NEW.coordination_record_id)
BEGIN SELECT RAISE(ABORT, 'MUTATION_GUARD_IDENTITY_IMMUTABLE'); END;

DROP TRIGGER mutation_guard_override_immutable;
CREATE TRIGGER mutation_guard_override_immutable
BEFORE UPDATE ON mutation_guard_overrides
WHEN NEW.id <> OLD.id OR NEW.mutation_guard_id <> OLD.mutation_guard_id
  OR NEW.guarded_run_id <> OLD.guarded_run_id OR NEW.colliding_run_id <> OLD.colliding_run_id
  OR NEW.created_at <> OLD.created_at OR NOT EXISTS (SELECT 1 FROM coordination_coalescing_permits
    WHERE alias_record_id = OLD.coordination_record_id AND canonical_record_id = NEW.coordination_record_id)
BEGIN SELECT RAISE(ABORT, 'MUTATION_GUARD_OVERRIDE_IMMUTABLE'); END;

INSERT INTO schema_migrations(version, applied_at)
VALUES (8, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
