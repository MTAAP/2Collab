ALTER TABLE local_processes RENAME TO local_processes_v2;

CREATE TABLE local_processes (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) BETWEEN 1 AND 128),
  reservation_id TEXT NOT NULL UNIQUE CHECK (length(reservation_id) BETWEEN 1 AND 128),
  assignment_digest TEXT NOT NULL CHECK (length(assignment_digest) = 64 AND assignment_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('RESERVED', 'STARTING', 'STARTED', 'FAILED_TO_START', 'EXITED', 'UNKNOWN')),
  host TEXT CHECK (host IS NULL OR host IN ('NATIVE', 'ORCA')),
  opaque_process_id TEXT CHECK (opaque_process_id IS NULL OR length(opaque_process_id) BETWEEN 1 AND 256),
  interaction TEXT CHECK (interaction IS NULL OR interaction IN ('HEADLESS', 'INTERACTIVE')),
  assurance TEXT CHECK (assurance IS NULL OR assurance = 'ADVISORY'),
  last_disposition TEXT CHECK (last_disposition IS NULL OR length(last_disposition) BETWEEN 1 AND 128),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (state IN ('RESERVED', 'STARTING') AND host IS NULL AND opaque_process_id IS NULL
      AND interaction IS NULL AND assurance IS NULL AND last_disposition IS NULL)
    OR (state = 'FAILED_TO_START' AND host IS NULL AND opaque_process_id IS NULL
      AND interaction IS NULL AND assurance IS NULL AND last_disposition IS NOT NULL)
    OR (state IN ('STARTED', 'EXITED', 'UNKNOWN') AND host IS NOT NULL
      AND opaque_process_id IS NOT NULL AND interaction IS NOT NULL AND assurance IS NOT NULL)
  )
) STRICT;

INSERT INTO local_processes(
  attempt_id, reservation_id, assignment_digest, state, host, opaque_process_id,
  interaction, assurance, last_disposition, created_at, updated_at
)
SELECT
  attempt_id, reservation_id, assignment_digest, state, host, opaque_process_id,
  interaction, assurance, last_disposition, created_at, updated_at
FROM local_processes_v2;

DROP TABLE local_processes_v2;

INSERT INTO schema_migrations(version, applied_at)
VALUES (3, CAST(strftime('%s', 'now') AS INTEGER));
