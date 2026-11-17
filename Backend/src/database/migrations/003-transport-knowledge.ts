export const transportKnowledgeSql = String.raw`
ALTER TABLE documents ADD COLUMN lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version >= 0);

-- A new draft does not invalidate the previous approved version.
-- Approval and archival eligibility are separate from any actual index/publication.
CREATE VIEW eligible_document_versions AS
SELECT v.id AS version_id, v.document_id, v.department_id
FROM document_versions v
JOIN version_reviews r ON r.version_id = v.id AND r.document_id = v.document_id AND r.department_id = v.department_id
JOIN documents d ON d.id = v.document_id AND d.department_id = v.department_id
WHERE r.status = 'approved' AND d.archived_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM document_versions newer JOIN version_reviews nr ON nr.version_id = newer.id
    WHERE newer.document_id = v.document_id AND newer.department_id = v.department_id
      AND newer.version_number > v.version_number AND nr.status = 'approved'
  );

CREATE TRIGGER indexing_requires_approval_insert BEFORE INSERT ON indexing_metadata
WHEN NOT EXISTS (
  SELECT 1 FROM eligible_document_versions e WHERE e.version_id = NEW.version_id
    AND e.document_id = NEW.document_id AND e.department_id = NEW.department_id
) BEGIN
  SELECT RAISE(ABORT, 'Indexing requires an eligible approved version');
END;
CREATE TRIGGER indexing_requires_approval_update BEFORE UPDATE ON indexing_metadata
WHEN NEW.status IN ('pending', 'ready') AND NOT EXISTS (
  SELECT 1 FROM eligible_document_versions e WHERE e.version_id = NEW.version_id
    AND e.document_id = NEW.document_id AND e.department_id = NEW.department_id
) BEGIN
  SELECT RAISE(ABORT, 'Indexing requires an eligible approved version');
END;
`;
