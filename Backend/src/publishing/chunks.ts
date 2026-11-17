import { createHash } from 'node:crypto';
import { KnowledgeError } from '../admin/knowledge-validation.ts';

export const CHUNKER_VERSION = 'complete-sentences-v1';
export interface Chunk { id: string; ordinal: number; text: string; hash: string; location: { start: number; end: number } }
export const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export function chunkText(versionId: string, text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let current: { start: number; end: number } | undefined;
  function flush() {
    if (!current) return;
    const value = text.slice(current.start, current.end);
    chunks.push({ id: versionId + ':' + chunks.length, ordinal: chunks.length, text: value, hash: hash(value), location: current });
    current = undefined;
  }
  for (const part of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)) {
    const sentence = part.segment.trim();
    if (!sentence) continue;
    // Never split a sentence/qualification simply to fit the model's context.
    if (sentence.length > 500) throw new KnowledgeError(422, 'PASSAGE_TOO_LONG', 'A sentence exceeds 500 characters. Create a revision with shorter sentences.');
    const start = part.index + part.segment.indexOf(sentence), end = start + sentence.length;
    if (current && end - current.start > 500) flush();
    current = current ? { start: current.start, end } : { start, end };
  }
  flush();
  if (!chunks.length || chunks.length > 200) throw new KnowledgeError(422, 'INVALID_PASSAGES', 'The text cannot be indexed within prototype limits.');
  return chunks;
}
