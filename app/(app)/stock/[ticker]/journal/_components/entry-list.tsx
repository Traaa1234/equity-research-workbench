import type { JournalEntry } from '@/lib/services/journal';
import { EntryCard } from './entry-card';

interface Props { entries: JournalEntry[]; }

export function EntryList({ entries }: Props) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground italic px-3 py-4">No entries yet for this position.</p>;
  }
  return (
    <div className="px-3">
      {entries.map((e) => <EntryCard key={String(e.id)} entry={e} />)}
    </div>
  );
}
