CREATE TABLE local_semantic_outbox (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 128),
  body_digest TEXT NOT NULL CHECK (
    length(body_digest) = 64 AND body_digest NOT GLOB '*[^0-9a-f]*'
  ),
  body_json TEXT NOT NULL CHECK (
    json_valid(body_json) AND length(CAST(body_json AS BLOB)) <= 65536
  ),
  byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 1 AND 65536),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TRIGGER local_semantic_outbox_immutable_update
BEFORE UPDATE ON local_semantic_outbox
BEGIN
  SELECT RAISE(ABORT, 'LOCAL_SEMANTIC_OUTBOX_IMMUTABLE');
END;

INSERT INTO schema_migrations(version, applied_at)
VALUES (4, CAST(strftime('%s', 'now') AS INTEGER));
