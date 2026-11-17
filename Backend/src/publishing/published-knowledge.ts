import type { DatabaseSync } from 'node:sqlite';
import { DOCUMENT_PREFIX, QUERY_PREFIX } from '../config.ts';
import type { KnowledgeIndex, Passage } from '../knowledge.ts';
import { OllamaError } from '../ollama.ts';
import { readArtifact, type ModelIdentity } from './artifacts.ts';

// Query publication eligibility on every ask and again before returning evidence.
// No JSON-baseline fallback, and no drafts/merely approved versions in this source.
export class PublishedKnowledge {
  constructor(privateDb: DatabaseSync, privateDirectory: string, privateModel: ModelIdentity) {
    this.db = privateDb; this.directory = privateDirectory; this.model = privateModel;
  }
  private readonly db: DatabaseSync;
  private readonly directory: string;
  private readonly model: ModelIdentity;
  private active(departmentId: string) {
    return this.db.prepare("SELECT p.index_id, p.version_id, p.document_id FROM publication_pointers p " +
      "JOIN documents d ON d.id=p.document_id AND d.department_id=p.department_id AND d.archived_at IS NULL " +
      "JOIN version_reviews r ON r.version_id=p.version_id AND r.document_id=p.document_id AND r.department_id=p.department_id AND r.status='approved' " +
      "JOIN indexing_metadata i ON i.id=p.index_id AND i.version_id=p.version_id AND i.department_id=p.department_id AND i.status='ready' " +
      "WHERE p.department_id=? ORDER BY p.document_id").all(departmentId);
  }
  getIndex(departmentId: string): KnowledgeIndex {
    try {
      const rows = departmentId === 'transport' ? this.active(departmentId) : [];
      const artifacts = rows.map(row => readArtifact(this.db, this.directory, String(row.index_id), this.model));
      const dimensions = artifacts[0]?.dimensions ?? 0;
      if (artifacts.some(a => a.dimensions !== dimensions)) throw new Error('Mixed embedding dimensions');
      return { schemaVersion: 1, createdAt: new Date().toISOString(), embeddingModel: this.model.name, embeddingModelDigest: this.model.digest,
        documentPrefix: DOCUMENT_PREFIX, queryPrefix: QUERY_PREFIX, datasetHash: 'published-only', dimensions,
        passages: artifacts.flatMap(a => a.passages) };
    } catch { throw new OllamaError('KNOWLEDGE_UNAVAILABLE', 'Published knowledge is temporarily unavailable.', 503); }
  }
  isCurrent(passages: Passage[]): boolean {
    try {
      const active = this.active('transport');
      return passages.every(p => p.departmentId === 'transport' && active.some(row =>
        row.index_id === p.indexId && row.version_id === p.versionId && row.document_id === p.documentId));
    } catch { return false; }
  }
}
