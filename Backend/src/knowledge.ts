import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DATASET_PATH, INDEX_PATH, DOCUMENT_PREFIX, QUERY_PREFIX, type Config } from './config.ts';

export interface Passage { id: string; departmentId: string; title: string; text: string }
export interface Dataset { fictional: true; description: string; passages: Passage[] }
export interface IndexedPassage extends Passage { embedding: number[] }
export interface KnowledgeIndex {
  schemaVersion: 1;
  createdAt: string;
  embeddingModel: string;
  embeddingModelDigest: string;
  documentPrefix: string;
  queryPrefix: string;
  datasetHash: string;
  dimensions: number;
  passages: IndexedPassage[];
}
export interface RetrievedPassage extends Passage { score: number }

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPassage(value: unknown): value is Passage {
  return isObject(value) && ['id', 'departmentId', 'title', 'text'].every(key =>
    typeof value[key] === 'string' && (value[key] as string).trim().length > 0);
}
export function validateDataset(value: unknown): Dataset {
  if (!isObject(value) || value.fictional !== true || typeof value.description !== 'string' ||
      !Array.isArray(value.passages) || value.passages.length === 0) {
    throw new Error('The dataset must explicitly be fictional and contain short passages.');
  }
  const ids = new Set<string>();
  for (const passage of value.passages) {
    if (!isPassage(passage) || passage.departmentId !== 'transport' ||
        passage.text.length > 500 || passage.title.length > 100 || !/^[A-Z0-9-]{1,32}$/.test(passage.id) ||
        ids.has(passage.id)) {
      throw new Error('Invalid, duplicate, overlong, or non-Transport dataset passage.');
    }
    ids.add(passage.id);
  }
  return value as unknown as Dataset;
}
export async function loadDataset(): Promise<Dataset> {
  return validateDataset(JSON.parse(await readFile(DATASET_PATH, 'utf8')));
}
export function datasetHash(dataset: Dataset): string {
  return createHash('sha256').update(JSON.stringify(dataset)).digest('hex');
}
export function validateVector(value: unknown, dimensions?: number): asserts value is number[] {
  if (!Array.isArray(value) || value.length === 0 || (dimensions !== undefined && value.length !== dimensions) ||
      !value.every(v => typeof v === 'number' && Number.isFinite(v)) ||
      !value.some(v => v !== 0) || !Number.isFinite(value.reduce((sum, v) => sum + v * v, 0))) {
    throw new Error('Embedding vector is invalid or its dimensions do not match the index.');
  }
}
export function validateIndex(value: unknown, dataset: Dataset, model: string, digest: string): KnowledgeIndex {
  const reindex = ' Run npm run index.';
  if (!isObject(value) || value.schemaVersion !== 1 || value.embeddingModel !== model ||
      value.embeddingModelDigest !== digest || value.datasetHash !== datasetHash(dataset) ||
      value.documentPrefix !== DOCUMENT_PREFIX || value.queryPrefix !== QUERY_PREFIX ||
      !Number.isInteger(value.dimensions) || Number(value.dimensions) < 1 ||
      !Array.isArray(value.passages) || value.passages.length !== dataset.passages.length) {
    throw new Error('Knowledge index is missing, incompatible, or stale.' + reindex);
  }
  for (let i = 0; i < dataset.passages.length; i++) {
    const actual: unknown = value.passages[i];
    const expected = dataset.passages[i]!;
    if (!isPassage(actual) || !['id', 'departmentId', 'title', 'text'].every(key =>
      actual[key as keyof Passage] === expected[key as keyof Passage])) {
      throw new Error('Knowledge index passages do not match the dataset.' + reindex);
    }
    try { validateVector((actual as unknown as Record<string, unknown>).embedding, Number(value.dimensions)); }
    catch { throw new Error('Knowledge index contains invalid vectors.' + reindex); }
  }
  return value as unknown as KnowledgeIndex;
}
export async function loadKnowledge(model: string, digest: string): Promise<KnowledgeIndex> {
  const dataset = await loadDataset();
  let stored: unknown;
  try { stored = JSON.parse(await readFile(INDEX_PATH, 'utf8')); }
  catch { throw new Error('Cannot read data/embeddings.json. Run npm run index.'); }
  return validateIndex(stored, dataset, model, digest);
}
export function cosineSimilarity(a: number[], b: number[]): number {
  validateVector(a);
  validateVector(b, a.length);
  let dot = 0, lengthA = 0, lengthB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    lengthA += a[i]! * a[i]!;
    lengthB += b[i]! * b[i]!;
  }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(lengthA * lengthB)));
}
export function serializeContext(passages: Passage[]): string {
  return JSON.stringify(passages.map(({ id, title, text }) => ({ id, title, text })));
}
export function retrieve(index: KnowledgeIndex, departmentId: string, query: number[], config: Config): RetrievedPassage[] {
  validateVector(query, index.dimensions);
  const ranked = index.passages.filter(p => p.departmentId === departmentId)
    .map(({ embedding, ...passage }) => ({ ...passage, score: cosineSimilarity(query, embedding) }))
    .filter(p => p.score >= config.relevanceThreshold)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const selected: RetrievedPassage[] = [];
  for (const passage of ranked) {
    if (selected.length >= config.topK) break;
    if (serializeContext([...selected, passage]).length <= config.maxContextChars) selected.push(passage);
  }
  return selected;
}

