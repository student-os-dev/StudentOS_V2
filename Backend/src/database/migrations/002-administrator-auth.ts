// Global authentication events have no department. Preserve all existing audit data.
export const administratorAuthSql = String.raw`
CREATE TABLE audit_events_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  department_id TEXT REFERENCES departments(id),
  document_id TEXT,
  version_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'administrator')),
  actor_id TEXT REFERENCES administrator_accounts(id),
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  details_json TEXT NOT NULL CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((actor_type = 'system' AND actor_id IS NULL) OR (actor_type = 'administrator' AND actor_id IS NOT NULL)),
  CHECK (document_id IS NULL OR department_id IS NOT NULL),
  CHECK (version_id IS NULL OR document_id IS NOT NULL),
  FOREIGN KEY (document_id, department_id) REFERENCES documents(id, department_id),
  FOREIGN KEY (version_id, document_id, department_id) REFERENCES document_versions(id, document_id, department_id)
) STRICT;
INSERT INTO audit_events_v2 SELECT * FROM audit_events;
DROP TABLE audit_events;
ALTER TABLE audit_events_v2 RENAME TO audit_events;
CREATE INDEX audit_department_time ON audit_events(department_id, occurred_at);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'Audit events are append-only');
END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'Audit events are append-only');
END;

CREATE TABLE administrator_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
  administrator_id TEXT NOT NULL UNIQUE REFERENCES administrator_accounts(id),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
) STRICT;
CREATE INDEX sessions_expiry ON administrator_sessions(expires_at);
CREATE TABLE login_rate_limits (
  bucket_hash TEXT PRIMARY KEY NOT NULL CHECK (length(bucket_hash) = 64),
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  resets_at INTEGER NOT NULL
) STRICT;
CREATE INDEX login_limits_expiry ON login_rate_limits(resets_at);
CREATE TRIGGER administrator_revoke_sessions AFTER UPDATE OF password_hash, disabled ON administrator_accounts BEGIN
  DELETE FROM administrator_sessions WHERE administrator_id = NEW.id;
END;
`;
