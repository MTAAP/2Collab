CREATE TABLE document_write_grants (
  grant_id TEXT PRIMARY KEY CHECK(length(grant_id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL REFERENCES projects(id), connector_id TEXT NOT NULL REFERENCES outline_connections(connector_id),
  run_id TEXT NOT NULL REFERENCES agent_runs(id), grantor_member_id TEXT NOT NULL REFERENCES members(id),
  connector_epoch INTEGER NOT NULL CHECK(connector_epoch > 0), grant_revision INTEGER NOT NULL CHECK(grant_revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0), expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  revoked_at INTEGER CHECK(revoked_at >= created_at),
  revocation_cause TEXT CHECK(revocation_cause IS NULL OR revocation_cause IN ('MEMBER','RUN','CONNECTOR','SCOPE','RESTORE','EXPLICIT'))
) STRICT;
CREATE TABLE document_write_grant_documents (
  grant_id TEXT NOT NULL REFERENCES document_write_grants(grant_id), document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 128),
  source_revision TEXT NOT NULL CHECK(length(source_revision) BETWEEN 1 AND 256), comparable_digest TEXT NOT NULL CHECK(length(comparable_digest)=64 AND comparable_digest NOT GLOB '*[^a-f0-9]*'),
  document_revision INTEGER NOT NULL CHECK(document_revision > 0), PRIMARY KEY(grant_id, document_id)
) STRICT;
CREATE TABLE document_write_grant_operations (
  grant_id TEXT NOT NULL REFERENCES document_write_grants(grant_id), operation TEXT NOT NULL CHECK(operation='EDIT_CONTENT'), PRIMARY KEY(grant_id, operation)
) STRICT;
CREATE TABLE additional_document_requests (
  request_id TEXT PRIMARY KEY CHECK(length(request_id) BETWEEN 1 AND 128), grant_id TEXT NOT NULL REFERENCES document_write_grants(grant_id),
  document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 128), requested_by_run_id TEXT NOT NULL REFERENCES agent_runs(id),
  status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED')), request_revision INTEGER NOT NULL CHECK(request_revision > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0), decided_by_member_id TEXT REFERENCES members(id), decided_at INTEGER CHECK(decided_at >= created_at),
  revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at >= created_at),
  revocation_cause TEXT CHECK(revocation_cause IS NULL OR revocation_cause IN ('MEMBER','RUN','CONNECTOR','SCOPE','RESTORE','EXPLICIT')),
  CHECK((status='PENDING' AND decided_by_member_id IS NULL AND decided_at IS NULL) OR (status IN ('APPROVED','REJECTED') AND decided_by_member_id IS NOT NULL AND decided_at IS NOT NULL))
) STRICT;
INSERT INTO schema_migrations(version, applied_at) VALUES (11, CAST(strftime('%s','now') AS INTEGER)*1000);
