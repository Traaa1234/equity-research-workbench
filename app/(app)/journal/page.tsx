import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { JournalService, type ListPositionsOpts } from '@/lib/services/journal';
import { PositionCard } from '../stock/[ticker]/journal/_components/position-card';
import { JournalEmpty } from '../stock/[ticker]/journal/_components/journal-empty';
import { JournalFilters } from './_components/journal-filters';

interface PageProps {
  searchParams: { status?: string; ticker?: string; minConviction?: string };
}

export default async function JournalPage({ searchParams }: PageProps) {
  const userId = await requireUserId();
  const svc = new JournalService({ db: getServiceDb() });

  const opts: ListPositionsOpts = {};
  if (searchParams.status === 'open' || searchParams.status === 'closed') opts.status = searchParams.status;
  if (searchParams.ticker) opts.ticker = searchParams.ticker.toUpperCase();
  if (searchParams.minConviction) opts.minConviction = Number(searchParams.minConviction);

  const positions = await svc.listPositions(userId, opts);
  const positionsWithEntries = await Promise.all(positions.map(async (p) => {
    const full = await svc.getPosition(userId, p.id);
    return { ...p, entries: full?.entries ?? [] };
  }));

  return (
    <article className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Trade Journal</h1>
        <p className="text-sm text-muted-foreground">All your tracked positions, across tickers.</p>
      </header>

      <JournalFilters />

      <Card>
        <CardHeader>
          <CardTitle>Positions ({positionsWithEntries.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {positionsWithEntries.length === 0
            ? <JournalEmpty variant="all" />
            : positionsWithEntries.map((p) => (
                <PositionCard
                  key={String(p.id)}
                  position={p}
                  entries={p.entries}
                  showTicker
                />
              ))
          }
        </CardContent>
      </Card>
    </article>
  );
}
