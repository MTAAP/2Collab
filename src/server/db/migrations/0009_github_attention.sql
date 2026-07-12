CREATE TABLE inbox_items (
  recipient_member_id TEXT NOT NULL REFERENCES members(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('ACTION_REQUIRED','BLOCKED','WARNING','OUTCOME')),
  event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 128),
  subject_key TEXT NOT NULL CHECK(length(subject_key) BETWEEN 1 AND 512),
  category TEXT NOT NULL CHECK (category IN ('ACTION_REQUIRED','BLOCKED','WARNING','OUTCOME')),
  material_digest TEXT NOT NULL CHECK(length(material_digest) = 64 AND material_digest NOT GLOB '*[^a-f0-9]*'),
  safe_summary TEXT NOT NULL CHECK(length(safe_summary) BETWEEN 1 AND 240),
  unread INTEGER NOT NULL CHECK (unread IN (0,1)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  last_material_change_at INTEGER NOT NULL CHECK(last_material_change_at >= created_at),
  read_at INTEGER CHECK(read_at >= created_at),
  resolved_at INTEGER CHECK(resolved_at >= 0),
  resolution_reason TEXT CHECK(resolution_reason IS NULL OR resolution_reason IN ('SOURCE_RESOLVED','MEMBER_DISMISSED','SUPERSEDED','RETENTION_EXPIRED')),
  source_revision TEXT CHECK(source_revision IS NULL OR length(source_revision) BETWEEN 1 AND 256),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY (recipient_member_id, event_type, subject_key)
) STRICT;
CREATE INDEX inbox_items_recipient_unread_idx ON inbox_items(recipient_member_id, unread, updated_at);
CREATE INDEX inbox_items_resolved_retention_idx ON inbox_items(resolved_at) WHERE resolved_at IS NOT NULL;

INSERT INTO schema_migrations(version, applied_at)
VALUES (9, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
