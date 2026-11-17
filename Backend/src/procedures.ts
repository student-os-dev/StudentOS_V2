import type { KnowledgeIndex, RetrievedPassage } from './knowledge.ts';
import { serializeContext } from './knowledge.ts';

// Bound local expansion; the model still receives only the small retrieval context.
export const PROCEDURE_MAX_CHUNKS = 12;
export const PROCEDURE_MAX_CHARS = 6000;
export function isProcedureQuestion(question: string): boolean {
  const fullRequest = /\b(?:list|outline|describe|explain|show|give|provide)\b[^?]*\b(?:steps|procedure|process)\b|\bwhat\s+(?:are|is)\b[^?]*\b(?:steps|procedure|process)\b|\bhow\s+(?:do|can|should)\s+(?:i|we|students)\b[^?]*\bapply\b/i.test(question);
  return fullRequest && !/\b(?:step\s*(?:\d+|one|two|three|four|five|six|seven)|(?:first|last|next|second|third)\s+step)\b/i.test(question);
}
function requestedCount(question: string): number | undefined {
  const words = ['one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty'];
  const match = question.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+steps?\b/i);
  return match ? (/^\d+$/.test(match[1]!) ? Number(match[1]) : words.indexOf(match[1]!.toLowerCase()) + 1) : undefined;
}
export function expandProcedure(index: KnowledgeIndex, anchors: RetrievedPassage[], question: string): { passages: RetrievedPassage[]; answer: string } | null {
  const anchor = anchors[0];
  if (!anchor?.documentId || !anchor.versionId || !anchor.indexId || anchors.some(p =>
    p.documentId !== anchor.documentId || p.versionId !== anchor.versionId || p.indexId !== anchor.indexId)) return null;
  const passages = index.passages.filter(p => p.departmentId === anchor.departmentId &&
    p.documentId === anchor.documentId && p.versionId === anchor.versionId && p.indexId === anchor.indexId)
    .map(({ embedding: _embedding, ...p }) => ({ ...p, score: anchor.score }))
    .sort((a, b) => (a.location?.start ?? 0) - (b.location?.start ?? 0));
  if (!passages.length || passages.length > PROCEDURE_MAX_CHUNKS || serializeContext(passages).length > PROCEDURE_MAX_CHARS ||
    passages.some((p, i) => !p.location || p.id !== anchor.versionId + ':' + i ||
      p.location.end - p.location.start !== p.text.length ||
      (i > 0 && p.location.start < passages[i - 1]!.location!.end))) return null;
  // Keep preconditions, full step bodies and final notes, including cross-chunk continuations.
  // Only whitespace between complete chunks changes; no generated prose is added.
  const answer = passages.map(p => p.text).join('\n\n');
  const steps = [...answer.matchAll(/(?:^|\n)[ \t]*(?:Step[ \t]+)?([1-9]\d?)[.:)][ \t]+/gi)];
  const count = requestedCount(question);
  if (steps.length < 2 || steps.length > 20 || (count !== undefined && count !== steps.length) ||
    steps.some((step, i) => Number(step[1]) !== i + 1)) return null;
  if (!answer.slice(steps.at(-1)!.index! + steps.at(-1)![0].length).trim()) return null;
  return { passages, answer };
}
