import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validateDataset, datasetHash } from '../knowledge.ts';
import { transaction } from './database.ts';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
function matches(actual: Record<string, unknown> | undefined, expected: Record<string, unknown>): boolean {
  return actual !== undefined && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

export function importTransport(db: DatabaseSync, input: unknown) {
  const dataset = validateDataset(input);
  const expectedIds = Array.from({ length: 10 }, (_, i) => 'TRN-' + String(i + 1).padStart(3, '0'));
  if (dataset.passages.length !== 10 || expectedIds.some(id => !dataset.passages.some(p => p.id === id))) {
    throw new Error('The baseline import requires exactly TRN-001 through TRN-010.');
  }
  return transaction(db, () => {
    db.prepare("INSERT INTO departments(id, name) VALUES ('transport', 'Transport') ON CONFLICT(id) DO NOTHING").run();
    let inserted = 0;
    let unchanged = 0;
    for (const passage of dataset.passages) {
      const versionId = passage.id + ':v1';
      const hash = sha256(passage.text);
      const locator = JSON.stringify({ kind: 'baseline_json', file: 'transport.json', passageId: passage.id });
      const details = JSON.stringify({ source: 'transport.json', datasetHash: datasetHash(dataset), fictional: true });
      const document = {
        id: passage.id, department_id: passage.departmentId, source_key: passage.id,
        source_kind: 'baseline_json', fictional: 1,
      };
      const version = {
        id: versionId, document_id: passage.id, department_id: passage.departmentId,
        version_number: 1, title: passage.title, content_text: passage.text, content_sha256: hash,
        original_filename: 'transport.json', media_type: 'application/json', storage_path: null, created_by: null,
      };
      const chunk = {
        id: passage.id, version_id: versionId, document_id: passage.id, department_id: passage.departmentId,
        ordinal: 0, text: passage.text, content_sha256: hash, locator_json: locator,
      };
      const audit = {
        id: 'baseline-import:' + versionId, department_id: passage.departmentId,
        document_id: passage.id, version_id: versionId, actor_type: 'system', actor_id: null,
        event_type: 'baseline_imported', details_json: details,
      };
      const existing = db.prepare('SELECT * FROM documents WHERE id = ?').get(passage.id);
      if (existing) {
        const review = db.prepare('SELECT * FROM version_reviews WHERE version_id = ?').get(versionId);
        if (!matches(existing, document) ||
            !matches(db.prepare('SELECT * FROM document_versions WHERE id = ?').get(versionId), version) ||
            !matches(db.prepare('SELECT * FROM knowledge_chunks WHERE id = ?').get(passage.id), chunk) ||
            !matches(review, { version_id: versionId, document_id: passage.id, department_id: passage.departmentId }) ||
            !matches(db.prepare('SELECT * FROM audit_events WHERE id = ?').get(audit.id), audit)) {
          throw new Error('Baseline import conflict for ' + passage.id + '; no records were changed. Investigate instead of overwriting history.');
        }
        unchanged++;
        continue;
      }
      db.prepare('INSERT INTO documents(id, department_id, source_key, source_kind, fictional) VALUES (?, ?, ?, ?, ?)')
        .run(document.id, document.department_id, document.source_key, document.source_kind, document.fictional);
      db.prepare('INSERT INTO document_versions(id, document_id, department_id, version_number, title, content_text, ' +
        'content_sha256, original_filename, media_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(version.id, version.document_id, version.department_id, version.version_number, version.title,
          version.content_text, version.content_sha256, version.original_filename, version.media_type);
      db.prepare('INSERT INTO knowledge_chunks(id, version_id, document_id, department_id, ordinal, text, content_sha256, locator_json) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(chunk.id, chunk.version_id, chunk.document_id, chunk.department_id, chunk.ordinal, chunk.text, chunk.content_sha256, chunk.locator_json);
      db.prepare('INSERT INTO version_reviews(version_id, document_id, department_id) VALUES (?, ?, ?)')
        .run(versionId, passage.id, passage.departmentId);
      db.prepare('INSERT INTO audit_events(id, department_id, document_id, version_id, actor_type, actor_id, event_type, details_json) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(audit.id, audit.department_id, audit.document_id, audit.version_id, audit.actor_type, audit.actor_id, audit.event_type, audit.details_json);
      inserted++;
    }
    return { inserted, unchanged, publicationsCreated: 0, administratorsCreated: 0 };
  });
}
