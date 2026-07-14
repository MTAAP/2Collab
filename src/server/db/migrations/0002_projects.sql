CREATE TABLE projects_v2 (
  id TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 128)
    CHECK (id GLOB '[A-Za-z0-9]*' AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  team_id TEXT NOT NULL REFERENCES deployments(team_id)
    CHECK (length(team_id) BETWEEN 1 AND 128)
    CHECK (team_id GLOB '[A-Za-z0-9]*' AND team_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  name TEXT NOT NULL
    CHECK (length(name) BETWEEN 1 AND 120 AND name = trim(name)),
  base_branch TEXT NOT NULL
    CHECK (length(base_branch) BETWEEN 1 AND 255)
    CHECK (base_branch NOT GLOB '-*')
    CHECK (base_branch NOT GLOB '/*' AND base_branch NOT GLOB '*/')
    CHECK (base_branch NOT GLOB '.*' AND base_branch NOT GLOB '*/.*')
    CHECK (base_branch NOT GLOB '*.lock' AND base_branch NOT GLOB '*.lock/*')
    CHECK (base_branch NOT GLOB '*..*' AND base_branch NOT GLOB '*//*')
    CHECK (base_branch NOT GLOB '*@{*')
    CHECK (base_branch NOT GLOB '*[~^:?*[]*')
    CHECK (base_branch NOT GLOB '*\*')
    CHECK (base_branch NOT GLOB '* *')
    CHECK (
      instr(base_branch, char(1)) = 0 AND instr(base_branch, char(2)) = 0
      AND instr(base_branch, char(3)) = 0 AND instr(base_branch, char(4)) = 0
      AND instr(base_branch, char(5)) = 0 AND instr(base_branch, char(6)) = 0
      AND instr(base_branch, char(7)) = 0 AND instr(base_branch, char(8)) = 0
      AND instr(base_branch, char(9)) = 0 AND instr(base_branch, char(10)) = 0
      AND instr(base_branch, char(11)) = 0 AND instr(base_branch, char(12)) = 0
      AND instr(base_branch, char(13)) = 0 AND instr(base_branch, char(14)) = 0
      AND instr(base_branch, char(15)) = 0 AND instr(base_branch, char(16)) = 0
      AND instr(base_branch, char(17)) = 0 AND instr(base_branch, char(18)) = 0
      AND instr(base_branch, char(19)) = 0 AND instr(base_branch, char(20)) = 0
      AND instr(base_branch, char(21)) = 0 AND instr(base_branch, char(22)) = 0
      AND instr(base_branch, char(23)) = 0 AND instr(base_branch, char(24)) = 0
      AND instr(base_branch, char(25)) = 0 AND instr(base_branch, char(26)) = 0
      AND instr(base_branch, char(27)) = 0 AND instr(base_branch, char(28)) = 0
      AND instr(base_branch, char(29)) = 0 AND instr(base_branch, char(30)) = 0
      AND instr(base_branch, char(31)) = 0 AND instr(base_branch, char(127)) = 0
    ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

DROP TABLE projects;
ALTER TABLE projects_v2 RENAME TO projects;

INSERT INTO schema_migrations(version, applied_at) VALUES (2, unixepoch());
