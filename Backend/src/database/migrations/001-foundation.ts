// Applied migrations are immutable. Add a new numbered migration for schema changes.
export const foundationSql = String.raw`
CREATE TABLE departments (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE administrator_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(email)) > 0),
  -- Encoded password hashes only. Authentication and complete hash validation are future work.
  password_hash TEXT NOT NULL CHECK (
    length(password_hash) >= 40 AND
    (password_hash GLOB '$argon2id$v=19$*' OR password_hash GLOB '$scrypt$*')
  ),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE department_memberships (
  department_id TEXT NOT NULL REFERENCES departments(id),
  administrator_id TEXT NOT NULL REFERENCES administrator_accounts(id),
  PRIMARY KEY (department_id, administrator_id)
) STRICT;

CREATE TABLE membership_permissions (
  department_id TEXT NOT NULL,
  administrator_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('edit', 'review', 'publish', 'archive')),
  PRIMARY KEY (department_id, administrator_id, permission),
  FOREIGN KEY (department_id, administrator_id)
    REFERENCES department_memberships(department_id, administrator_id)
) STRICT;

CREATE TABLE documents (
  id TEXT PRIMARY KEY NOT NULL,
  department_id TEXT NOT NULL REFERENCES departments(id),
  source_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('baseline_json', 'plain_text', 'pdf', 'docx', 'image')),
  fictional INTEGER NOT NULL DEFAULT 0 CHECK (fictional IN (0, 1)),
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (department_id, source_key),
  UNIQUE (id, department_id)
) STRICT;

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  content_text TEXT NOT NULL CHECK (length(trim(content_text)) > 0),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  original_filename TEXT,
  media_type TEXT,
  storage_path TEXT,
  created_by TEXT REFERENCES administrator_accounts(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (document_id, version_number),
  UNIQUE (id, document_id, department_id),
  FOREIGN KEY (document_id, department_id) REFERENCES documents(id, department_id),
  FOREIGN KEY (department_id, created_by) REFERENCES department_memberships(department_id, administrator_id)
) STRICT;

-- Workflow metadata is separate: version content never changes, even while in draft.
CREATE TABLE version_reviews (
  version_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'approved', 'rejected')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  note TEXT,
  FOREIGN KEY (version_id, document_id, department_id)
    REFERENCES document_versions(id, document_id, department_id),
  FOREIGN KEY (department_id, reviewed_by)
    REFERENCES department_memberships(department_id, administrator_id),
  CHECK (status NOT IN ('approved', 'rejected') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
) STRICT;

CREATE TABLE knowledge_chunks (
  id TEXT PRIMARY KEY NOT NULL,
  version_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  locator_json TEXT NOT NULL CHECK (json_valid(locator_json) AND json_type(locator_json) = 'object'),
  UNIQUE (version_id, ordinal),
  FOREIGN KEY (version_id, document_id, department_id)
    REFERENCES document_versions(id, document_id, department_id)
) STRICT;

CREATE TABLE indexing_metadata (
  id TEXT PRIMARY KEY NOT NULL,
  version_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  model_digest TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  document_prefix TEXT NOT NULL,
  query_prefix TEXT NOT NULL,
  chunker_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  artifact_path TEXT,
  artifact_sha256 TEXT CHECK (artifact_sha256 IS NULL OR
    (length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*')),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT,
  UNIQUE (id, version_id, document_id, department_id),
  FOREIGN KEY (version_id, document_id, department_id)
    REFERENCES document_versions(id, document_id, department_id),
  CHECK (status != 'ready' OR (artifact_path IS NOT NULL AND length(artifact_path) > 0
    AND artifact_sha256 IS NOT NULL AND completed_at IS NOT NULL AND chunk_count > 0))
) STRICT;

CREATE TABLE publication_pointers (
  document_id TEXT PRIMARY KEY NOT NULL,
  department_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  index_id TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (version_id, document_id, department_id)
    REFERENCES document_versions(id, document_id, department_id),
  FOREIGN KEY (index_id, version_id, document_id, department_id)
    REFERENCES indexing_metadata(id, version_id, document_id, department_id),
  FOREIGN KEY (department_id, published_by)
    REFERENCES department_memberships(department_id, administrator_id)
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  department_id TEXT NOT NULL REFERENCES departments(id),
  document_id TEXT,
  version_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'administrator')),
  actor_id TEXT REFERENCES administrator_accounts(id),
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  details_json TEXT NOT NULL CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((actor_type = 'system' AND actor_id IS NULL) OR (actor_type = 'administrator' AND actor_id IS NOT NULL)),
  CHECK (version_id IS NULL OR document_id IS NOT NULL),
  FOREIGN KEY (document_id, department_id) REFERENCES documents(id, department_id),
  FOREIGN KEY (version_id, document_id, department_id)
    REFERENCES document_versions(id, document_id, department_id)
) STRICT;

CREATE INDEX chunks_department_version ON knowledge_chunks(department_id, version_id);
CREATE INDEX versions_department_document ON document_versions(department_id, document_id);
CREATE INDEX indexes_version_status ON indexing_metadata(version_id, status);
CREATE INDEX reviews_department_status ON version_reviews(department_id, status);
CREATE INDEX audit_department_time ON audit_events(department_id, occurred_at);

CREATE TRIGGER versions_no_update BEFORE UPDATE ON document_versions BEGIN
  SELECT RAISE(ABORT, 'Document versions are immutable; create a new version');
END;
CREATE TRIGGER versions_no_delete BEFORE DELETE ON document_versions BEGIN
  SELECT RAISE(ABORT, 'Document versions are immutable; archive the document');
END;
CREATE TRIGGER chunks_no_update BEFORE UPDATE ON knowledge_chunks BEGIN
  SELECT RAISE(ABORT, 'Knowledge chunks are immutable');
END;
CREATE TRIGGER chunks_no_delete BEFORE DELETE ON knowledge_chunks BEGIN
  SELECT RAISE(ABORT, 'Knowledge chunks are immutable');
END;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'Audit events are append-only');
END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'Audit events are append-only');
END;

CREATE TRIGGER publication_check_insert BEFORE INSERT ON publication_pointers BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM documents d
    JOIN version_reviews r ON r.document_id = d.id AND r.department_id = d.department_id
    JOIN indexing_metadata i ON i.version_id = r.version_id AND i.document_id = d.id AND i.department_id = d.department_id
    WHERE d.id = NEW.document_id AND d.department_id = NEW.department_id AND d.archived_at IS NULL
      AND r.version_id = NEW.version_id AND r.status = 'approved'
      AND i.id = NEW.index_id AND i.status = 'ready'
  ) THEN RAISE(ABORT, 'Publication requires an approved version, ready index, and unarchived document') END;
END;
CREATE TRIGGER publication_check_update BEFORE UPDATE ON publication_pointers BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM documents d
    JOIN version_reviews r ON r.document_id = d.id AND r.department_id = d.department_id
    JOIN indexing_metadata i ON i.version_id = r.version_id AND i.document_id = d.id AND i.department_id = d.department_id
    WHERE d.id = NEW.document_id AND d.department_id = NEW.department_id AND d.archived_at IS NULL
      AND r.version_id = NEW.version_id AND r.status = 'approved'
      AND i.id = NEW.index_id AND i.status = 'ready'
  ) THEN RAISE(ABORT, 'Publication requires an approved version, ready index, and unarchived document') END;
END;
CREATE TRIGGER document_unpublish_before_archive BEFORE UPDATE OF archived_at ON documents
WHEN NEW.archived_at IS NOT NULL AND EXISTS (SELECT 1 FROM publication_pointers WHERE document_id = OLD.id) BEGIN
  SELECT RAISE(ABORT, 'Remove the publication pointer before archiving');
END;
CREATE TRIGGER review_unpublish_before_update BEFORE UPDATE ON version_reviews
WHEN EXISTS (SELECT 1 FROM publication_pointers WHERE version_id = OLD.version_id) BEGIN
  SELECT RAISE(ABORT, 'Remove the publication pointer before changing review metadata');
END;
CREATE TRIGGER review_unpublish_before_delete BEFORE DELETE ON version_reviews
WHEN EXISTS (SELECT 1 FROM publication_pointers WHERE version_id = OLD.version_id) BEGIN
  SELECT RAISE(ABORT, 'Remove the publication pointer before deleting review metadata');
END;
CREATE TRIGGER published_index_no_update BEFORE UPDATE ON indexing_metadata
WHEN EXISTS (SELECT 1 FROM publication_pointers WHERE index_id = OLD.id) BEGIN
  SELECT RAISE(ABORT, 'Published index metadata is immutable');
END;
`;
