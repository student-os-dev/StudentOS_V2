import { ChevronDown } from 'lucide-react';
import type { SourceReference } from './types/conversation';
import { groupSources } from './sourcePresentation';

export function SourceReferences({ sources, answer }: { sources: SourceReference[]; answer: string }) {
  const groups = groupSources(sources, answer);
  return <section className="source-references" aria-label="Answer sources">
    <div className="source-count">Sources ? {groups.length}</div>
    {groups.map(group => <article className="source-card" key={group.key}>
      <h3>{group.title}</h3>
      <p className="source-excerpt">{group.excerpt}</p>
      <details>
        <summary>Full evidence <ChevronDown size={14}/></summary>
        {group.evidence.map(source => <div className="source-evidence" key={source.id}>
          <p>{source.passage}</p><small>Reference: {source.id}</small>
        </div>)}
      </details>
    </article>)}
  </section>;
}
