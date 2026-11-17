import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PROJECT_ROOT, DOCUMENT_PREFIX, QUERY_PREFIX } from '../config.ts';
import { validateVector, isObject, type IndexedPassage } from '../knowledge.ts';
import { CHUNKER_VERSION, hash } from './chunks.ts';

export interface ModelIdentity { name: string; digest: string }
export interface Artifact {
  schemaVersion: 1; indexId: string; documentId: string; versionId: string; departmentId: 'transport';
  model: ModelIdentity; dimensions: number; documentPrefix: string; queryPrefix: string; chunkerVersion: string;
  passages: IndexedPassage[];
}
export const ARTIFACT_DIRECTORY = resolve(PROJECT_ROOT, 'data', 'indexes');
export function artifactPath(directory: string, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid artifact identity');
  return resolve(directory, id + '.json');
}
export function readArtifact(db: DatabaseSync, directory: string, id: string, expectedModel: ModelIdentity): Artifact {
  const row = db.prepare('SELECT * FROM indexing_metadata WHERE id = ? AND status = ?').get(id, 'ready');
  if (!row || row.department_id !== 'transport' || row.embedding_model !== expectedModel.name || row.model_digest !== expectedModel.digest ||
      row.document_prefix !== DOCUMENT_PREFIX || row.query_prefix !== QUERY_PREFIX || row.chunker_version !== CHUNKER_VERSION ||
      row.artifact_path !== 'indexes/' + id + '.json') throw new Error('Incompatible index');
  const path = artifactPath(directory, id);
  if (statSync(path).size > 32 * 1024 * 1024) throw new Error('Index is oversized');
  const bytes = readFileSync(path);
  if (bytes.length > 32 * 1024 * 1024 || hash(bytes) !== row.artifact_sha256) throw new Error('Invalid index checksum');
  const artifact: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isObject(artifact) || artifact.schemaVersion !== 1 || artifact.indexId !== id ||
      artifact.documentId !== row.document_id || artifact.versionId !== row.version_id || artifact.departmentId !== 'transport' ||
      !isObject(artifact.model) || artifact.model.name !== expectedModel.name || artifact.model.digest !== expectedModel.digest ||
      artifact.dimensions !== row.dimensions || artifact.documentPrefix !== DOCUMENT_PREFIX || artifact.queryPrefix !== QUERY_PREFIX ||
      artifact.chunkerVersion !== CHUNKER_VERSION || !Array.isArray(artifact.passages) || artifact.passages.length !== row.chunk_count) throw new Error('Invalid index');
  const chunks = db.prepare('SELECT * FROM knowledge_chunks WHERE version_id = ? AND document_id = ? AND department_id = ? ORDER BY ordinal')
    .all(String(row.version_id), String(row.document_id), 'transport');
  const version = db.prepare('SELECT title FROM document_versions WHERE id = ?').get(String(row.version_id));
  if (chunks.length !== artifact.passages.length) throw new Error('Index chunks differ');
  for (const [position, passage] of artifact.passages.entries()) {
    const chunk = chunks[position]!;
    if (!isObject(passage) || passage.id !== chunk.id || passage.departmentId !== 'transport' ||
        passage.documentId !== row.document_id || passage.versionId !== row.version_id || passage.indexId !== id ||
        passage.title !== version?.title || passage.text !== chunk.text || hash(String(passage.text)) !== chunk.content_sha256 ||
        JSON.stringify(passage.location) !== chunk.locator_json) throw new Error('Index evidence differs');
    validateVector(passage.embedding, Number(row.dimensions));
  }
  return artifact as unknown as Artifact;
}
