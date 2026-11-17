import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/database.ts';
import { KnowledgeError, type TextInput } from './knowledge-validation.ts';
import type { Permission } from './provision.ts';

const DEPARTMENT = 'transport';
type Actor = () => string;
type Row = Record<string, unknown>;
const notFound = () => new KnowledgeError(404, 'NOT_FOUND', 'Document or version not found.');
const conflict = () => new KnowledgeError(409, 'INVALID_TRANSITION', 'This action is not valid for the current document state.');
export const documentTag = (id: string, revision: number) => '"' + id + ':' + revision + '"';

export function createKnowledgeService(db: DatabaseSync) {
  function grant(actor: Actor, permissions: readonly Permission[]): string {
    const id = actor(); // Recheck session inside the same transaction as the operation.
    const granted = db.prepare('SELECT p.permission FROM membership_permissions p ' +
      'JOIN department_memberships m ON m.department_id = p.department_id AND m.administrator_id = p.administrator_id ' +
      'JOIN administrator_accounts a ON a.id = m.administrator_id AND a.disabled = 0 ' +
      'WHERE p.department_id = ? AND p.administrator_id = ?').all(DEPARTMENT, id);
    if (!granted.some(row => permissions.includes(row.permission as Permission))) {
      throw new KnowledgeError(403, 'FORBIDDEN', 'Access denied.');
    }
    return id;
  }
  function document(id: string): Row {
    const row = db.prepare('SELECT * FROM documents WHERE id = ? AND department_id = ?').get(id, DEPARTMENT);
    if (!row) throw notFound();
    return row;
  }
  function latest(id: string): Row {
    const row = db.prepare('SELECT v.id, v.version_number, r.status FROM document_versions v ' +
      'JOIN version_reviews r ON r.version_id = v.id AND r.document_id = v.document_id AND r.department_id = v.department_id ' +
      'WHERE v.document_id = ? AND v.department_id = ? ORDER BY v.version_number DESC LIMIT 1').get(id, DEPARTMENT);
    if (!row) throw notFound();
    return row;
  }
  function version(documentId: string, versionId: string, includeText = true) {
    const row = db.prepare('SELECT v.id, v.version_number, v.title, v.content_text, v.content_sha256, v.original_filename, v.media_type, ' +
      'v.created_by, v.created_at, r.status, r.reviewed_by, r.reviewed_at, r.note, ' +
      'EXISTS(SELECT 1 FROM eligible_document_versions e WHERE e.version_id = v.id AND e.department_id = v.department_id) AS eligible ' +
      'FROM document_versions v JOIN version_reviews r ON r.version_id = v.id AND r.document_id = v.document_id AND r.department_id = v.department_id ' +
      'WHERE v.id = ? AND v.document_id = ? AND v.department_id = ?').get(versionId, documentId, DEPARTMENT);
    if (!row) throw notFound();
    return {
      id: String(row.id), versionNumber: Number(row.version_number), title: String(row.title),
      ...(includeText ? { text: String(row.content_text) } : {}),
      contentSha256: String(row.content_sha256), originalFilename: row.original_filename, mediaType: row.media_type,
      createdBy: row.created_by, createdAt: row.created_at, status: String(row.status),
      reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, reviewNote: row.note,
      indexingEligible: row.eligible === 1,
    };
  }
  function describe(id: string, includeText = true) {
    const row = document(id);
    const current = latest(id);
    return {
      id, departmentId: DEPARTMENT, sourceKind: String(row.source_kind), sourceKey: String(row.source_key),
      fictional: row.fictional === 1, readOnly: row.source_kind !== 'plain_text',
      archivedAt: row.archived_at, createdAt: row.created_at, lockVersion: Number(row.lock_version),
      etag: documentTag(id, Number(row.lock_version)),
      latestVersion: version(id, String(current.id), includeText),
    };
  }
  function writable(id: string, expected: string): Row {
    const row = document(id);
    if (row.source_kind !== 'plain_text') throw new KnowledgeError(403, 'READ_ONLY_BASELINE', 'Imported baseline documents are read-only.');
    if (documentTag(id, Number(row.lock_version)) !== expected) {
      throw new KnowledgeError(412, 'STALE_DOCUMENT', 'The document changed. Reload it before retrying.');
    }
    if (row.archived_at !== null) throw conflict();
    return row;
  }
  function bump(row: Row) {
    const result = db.prepare('UPDATE documents SET lock_version = lock_version + 1 ' +
      'WHERE id = ? AND department_id = ? AND lock_version = ? AND archived_at IS NULL')
      .run(String(row.id), DEPARTMENT, Number(row.lock_version));
    if (result.changes !== 1) throw new KnowledgeError(412, 'STALE_DOCUMENT', 'The document changed. Reload it before retrying.');
  }
  function audit(event: string, actor: string, documentId: string, versionId: string, details: Record<string, unknown>) {
    db.prepare('INSERT INTO audit_events(id, department_id, document_id, version_id, actor_type, actor_id, event_type, details_json) ' +
      "VALUES (?, ?, ?, ?, 'administrator', ?, ?, ?)").run(randomUUID(), DEPARTMENT, documentId, versionId, actor, event, JSON.stringify(details));
  }
  function insertVersion(documentId: string, number: number, input: TextInput, actor: string) {
    const id = randomUUID();
    const hash = createHash('sha256').update(input.text, 'utf8').digest('hex');
    db.prepare('INSERT INTO document_versions(id, document_id, department_id, version_number, title, content_text, content_sha256, media_type, created_by) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'text/plain', ?)").run(id, documentId, DEPARTMENT, number, input.title, input.text, hash, actor);
    db.prepare('INSERT INTO version_reviews(version_id, document_id, department_id) VALUES (?, ?, ?)').run(id, documentId, DEPARTMENT);
    return id;
  }
  return {
    list(actor: Actor, limit: number, offset: number) {
      return transaction(db, () => {
        grant(actor, ['edit', 'publish']);
        const rows = db.prepare('SELECT id FROM documents WHERE department_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?')
          .all(DEPARTMENT, limit, offset);
        return { documents: rows.map(row => describe(String(row.id), false)), limit, offset };
      });
    },
    view(actor: Actor, id: string) {
      return transaction(db, () => { grant(actor, ['edit', 'publish']); return { document: describe(id) }; });
    },
    versions(actor: Actor, id: string, limit: number, offset: number) {
      return transaction(db, () => {
        grant(actor, ['edit', 'publish']); document(id);
        const rows = db.prepare('SELECT id FROM document_versions WHERE document_id = ? AND department_id = ? ORDER BY version_number DESC LIMIT ? OFFSET ?')
          .all(id, DEPARTMENT, limit, offset);
        return { versions: rows.map(row => version(id, String(row.id), false)), limit, offset };
      });
    },
    viewVersion(actor: Actor, id: string, versionId: string) {
      return transaction(db, () => { grant(actor, ['edit', 'publish']); document(id); return { version: version(id, versionId) }; });
    },
    create(actor: Actor, input: TextInput) {
      return transaction(db, () => {
        const administrator = grant(actor, ['edit']);
        const id = randomUUID();
        db.prepare("INSERT INTO documents(id, department_id, source_key, source_kind, fictional) VALUES (?, ?, ?, 'plain_text', ?)")
          .run(id, DEPARTMENT, 'manual:' + id, input.fictional ? 1 : 0);
        const versionId = insertVersion(id, 1, input, administrator);
        audit('document_created', administrator, id, versionId, { to: 'draft', lockVersion: 0 });
        return { document: describe(id) };
      });
    },
    revise(actor: Actor, id: string, expected: string, input: TextInput) {
      return transaction(db, () => {
        const administrator = grant(actor, ['edit']);
        const row = writable(id, expected);
        const current = latest(id);
        if (current.status === 'in_review') throw conflict();
        bump(row);
        const versionId = insertVersion(id, Number(current.version_number) + 1, input, administrator);
        audit('document_revised', administrator, id, versionId,
          { previousVersionId: current.id, to: 'draft', lockVersion: Number(row.lock_version) + 1 });
        return { document: describe(id) };
      });
    },
    transition(actor: Actor, id: string, versionId: string, expected: string, action: 'submit' | 'approve' | 'reject', note: string | null) {
      return transaction(db, () => {
        const administrator = grant(actor, [action === 'submit' ? 'edit' : 'publish']);
        const row = writable(id, expected);
        version(id, versionId); // Must belong to this exact Transport document.
        const current = latest(id);
        const from = action === 'submit' ? 'draft' : 'in_review';
        const to = action === 'submit' ? 'in_review' : action === 'approve' ? 'approved' : 'rejected';
        if (current.id !== versionId || current.status !== from) throw conflict();
        bump(row);
        const result = action === 'submit' ?
          db.prepare('UPDATE version_reviews SET status = ? WHERE version_id = ? AND document_id = ? AND department_id = ? AND status = ?')
            .run(to, versionId, id, DEPARTMENT, from) :
          db.prepare("UPDATE version_reviews SET status = ?, reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), note = ? " +
            'WHERE version_id = ? AND document_id = ? AND department_id = ? AND status = ?').run(to, administrator, note, versionId, id, DEPARTMENT, from);
        if (result.changes !== 1) throw conflict();
        audit('version_' + (action === 'submit' ? 'submitted' : action === 'approve' ? 'approved' : 'rejected'),
          administrator, id, versionId, { from, to, lockVersion: Number(row.lock_version) + 1 });
        return { document: describe(id) };
      });
    },
    archive(actor: Actor, id: string, expected: string) {
      return transaction(db, () => {
        const administrator = grant(actor, ['publish']);
        const row = writable(id, expected);
        const current = latest(id);
        bump(row);
        // Required even if a future publication pointer exists. Removal and archive commit together.
        const removed = db.prepare('DELETE FROM publication_pointers WHERE document_id = ? AND department_id = ?').run(id, DEPARTMENT);
        db.prepare("UPDATE documents SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND department_id = ?").run(id, DEPARTMENT);
        audit('document_archived', administrator, id, String(current.id),
          { publicationPointersRemoved: Number(removed.changes), lockVersion: Number(row.lock_version) + 1 });
        return { document: describe(id) };
      });
    },
  };
}
