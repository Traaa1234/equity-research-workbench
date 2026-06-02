import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { JournalPosition, JournalEntry } from '@/lib/services/journal';
import { summarizePosition } from '@/lib/compute/journal-summary';
import { EntryList } from './entry-list';

interface Props {
  position: JournalPosition;
  entries?: JournalEntry[];
  expanded?: boolean;
  showTicker?: boolean;
}

export function PositionCard({ position, entries = [], expanded = false, showTicker = false }: Props) {
  const latestEntry = entries.length > 0 ? entries[entries.length - 1]! : null;
  const summary = summarizePosition({
    status: position.status,
    openedAt: position.openedAt,
    closedAt: position.closedAt,
    latestEntry: latestEntry ? {
      kind: latestEntry.kind, occurredAt: latestEntry.occurredAt, thesisMd: latestEntry.thesisMd
    } : null,
    now: new Date()
  });

  return (
    <article className={cn('rounded border border-border overflow-hidden mb-3 last:mb-0',
      position.status === 'closed' && 'opacity-80')}>
      <header className="flex items-baseline justify-between px-3 py-2 bg-muted/50">
        <div className="flex items-baseline gap-3">
          {showTicker && (
            <Link href={`/stock/${position.ticker}/journal`} className="font-mono font-medium hover:text-primary">
              {position.ticker}
            </Link>
          )}
          <span className={cn('text-xs px-2 py-0.5 rounded uppercase tracking-wide',
            position.status === 'open' ? 'bg-emerald-100 text-emerald-800' : 'bg-muted text-muted-foreground')}>
            {position.status}
          </span>
          {summary.stale && (
            <span className="text-xs px-2 py-0.5 rounded uppercase tracking-wide bg-amber-100 text-amber-800">
              stale
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            opened {position.openedAt}
            {position.closedAt && ` · closed ${position.closedAt}`}
            {' · '}{summary.daysHeld}d held
          </span>
          {position.convictionAtOpen != null && (
            <span className="text-xs text-muted-foreground">· conviction {position.convictionAtOpen}/10</span>
          )}
        </div>
      </header>
      {!expanded && summary.thesisPreview && (
        <p className="text-sm text-muted-foreground italic px-3 py-2">{summary.thesisPreview}</p>
      )}
      {expanded && <EntryList entries={entries} />}
    </article>
  );
}
