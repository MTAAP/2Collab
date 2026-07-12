CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
) STRICT;

CREATE TABLE project_checkouts (
  server_origin TEXT NOT NULL CHECK (length(server_origin) BETWEEN 1 AND 2048),
  project_id TEXT NOT NULL
    CHECK (length(project_id) BETWEEN 1 AND 128)
    CHECK (project_id GLOB '[A-Za-z0-9]*' AND project_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  team_id TEXT NOT NULL
    CHECK (length(team_id) BETWEEN 1 AND 128)
    CHECK (team_id GLOB '[A-Za-z0-9]*' AND team_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  base_branch TEXT NOT NULL CHECK (length(base_branch) BETWEEN 1 AND 255),
  preferred_checkout TEXT NOT NULL UNIQUE CHECK (length(preferred_checkout) BETWEEN 1 AND 4096),
  config_sha256 TEXT NOT NULL
    CHECK (length(config_sha256) = 64 AND config_sha256 NOT GLOB '*[^a-f0-9]*'),
  registered_at INTEGER NOT NULL CHECK (registered_at >= 0),
  last_accessed_at INTEGER NOT NULL CHECK (last_accessed_at >= registered_at),
  PRIMARY KEY (server_origin, project_id)
) STRICT;

INSERT INTO schema_migrations(version, applied_at) VALUES (1, unixepoch());
