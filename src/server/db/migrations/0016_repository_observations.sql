CREATE TABLE runner_repository_observations (
  runner_id TEXT NOT NULL REFERENCES runners(id),
  runner_epoch INTEGER NOT NULL CHECK(runner_epoch > 0),
  project_id TEXT NOT NULL REFERENCES projects(id),
  mapping_revision INTEGER NOT NULL CHECK(mapping_revision > 0),
  base_branch TEXT NOT NULL CHECK(length(base_branch) BETWEEN 1 AND 255),
  base_commit TEXT NOT NULL CHECK(
    length(base_commit) IN (40, 64) AND base_commit NOT GLOB '*[^a-f0-9]*'
  ),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  PRIMARY KEY(runner_id, project_id, mapping_revision),
  FOREIGN KEY(runner_id, project_id, mapping_revision)
    REFERENCES runner_mapping_versions(runner_id, project_id, revision)
) STRICT;

CREATE INDEX runner_repository_observations_freshness
  ON runner_repository_observations(runner_id, project_id, mapping_revision, observed_at);

INSERT INTO schema_migrations(version, applied_at)
VALUES (16, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
