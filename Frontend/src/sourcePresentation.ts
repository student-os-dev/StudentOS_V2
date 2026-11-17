import type { SourceReference } from './types/conversation.ts';

export function groupSources(sources: SourceReference[], answer: string) {
  const groups = new Map<string, { key: string; title: string; excerpt: string; evidence: SourceReference[] }>();
  for (const source of sources) {
    const key = source.documentId ? JSON.stringify([source.documentId, source.versionId ?? '']) : source.id;
    let group = groups.get(key);
    if (!group) {
      const sentences = Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(source.passage), s => s.segment.trim());
      const relevant = source.excerpt || sentences.find(s => s && answer.includes(s)) || source.passage;
      const compact = relevant.replace(/\s+/g, ' ').trim();
      const withoutTitle = compact.startsWith(source.title) ? compact.slice(source.title.length).trim() : compact;
      const text = withoutTitle || compact;
      const excerpt = text.length <= 240 ? text : text.slice(0, 237).replace(/\s+\S*$/, '') + '?';
      group = { key, title: source.title, excerpt, evidence: [] };
      groups.set(key, group);
    }
    if (!group.evidence.some(p => p.id === source.id || p.passage === source.passage)) group.evidence.push(source);
  }
  return [...groups.values()];
}
