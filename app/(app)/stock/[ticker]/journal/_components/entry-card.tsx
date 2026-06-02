import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';
import type { JournalEntry } from '@/lib/services/journal';

interface Props { entry: JournalEntry; }

const KIND_LABELS: Record<JournalEntry['kind'], string> = {
  entry: 'Open',
  review: 'Review',
  exit: 'Exit'
};

const KIND_COLORS: Record<JournalEntry['kind'], string> = {
  entry: 'bg-blue-100 text-blue-800',
  review: 'bg-amber-100 text-amber-800',
  exit: 'bg-emerald-100 text-emerald-800'
};

export function EntryCard({ entry }: Props) {
  return (
    <article className="border-b border-border last:border-0 py-4">
      <header className="flex items-baseline gap-2 mb-2">
        <span className={cn('text-xs px-2 py-0.5 rounded uppercase tracking-wide', KIND_COLORS[entry.kind])}>
          {KIND_LABELS[entry.kind]}
        </span>
        <span className="text-xs text-muted-foreground">{entry.occurredAt}</span>
        {entry.convictionAtTime != null && (
          <span className="text-xs text-muted-foreground">· conviction {entry.convictionAtTime}/10</span>
        )}
        {entry.outcome && (
          <span className="text-xs text-muted-foreground">· outcome: {entry.outcome}</span>
        )}
      </header>
      <div className="prose prose-sm max-w-none">
        <ReactMarkdown>{entry.thesisMd}</ReactMarkdown>
      </div>
      {entry.whatChanged && (
        <div className="mt-2 text-sm">
          <div className="font-medium text-xs uppercase text-muted-foreground mb-1">What changed</div>
          <div className="prose prose-sm max-w-none">
            <ReactMarkdown>{entry.whatChanged}</ReactMarkdown>
          </div>
        </div>
      )}
      {entry.lessons && (
        <div className="mt-2 text-sm">
          <div className="font-medium text-xs uppercase text-muted-foreground mb-1">Lessons</div>
          <div className="prose prose-sm max-w-none">
            <ReactMarkdown>{entry.lessons}</ReactMarkdown>
          </div>
        </div>
      )}
    </article>
  );
}
