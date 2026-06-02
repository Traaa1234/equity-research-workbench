import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { JournalService } from '@/lib/services/journal';
import { DashboardTabs } from '../_components/dashboard-tabs';
import { PositionCard } from './_components/position-card';
import { PositionEditor } from './_components/position-editor';
import { JournalEmpty } from './_components/journal-empty';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface PageProps { params: { ticker: string }; }

export default async function TickerJournalPage({ params }: PageProps) {
  const userId = await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  const svc = new JournalService({ db: getServiceDb() });
  const positions = await svc.listPositions(userId, { ticker });

  const positionsWithEntries = await Promise.all(
    positions.map(async (p) => {
      const full = await svc.getPosition(userId, p.id);
      return { ...p, entries: full?.entries ?? [] };
    })
  );

  const open = positionsWithEntries.filter((p) => p.status === 'open');
  const closed = positionsWithEntries.filter((p) => p.status === 'closed');

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">Trade journal</p>
        </div>
        <DashboardTabs ticker={ticker} active="journal" />
      </header>

      <Card>
        <CardHeader><CardTitle>New position</CardTitle></CardHeader>
        <CardContent>
          <PositionEditor ticker={ticker} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Open positions ({open.length})</CardTitle></CardHeader>
        <CardContent>
          {open.length === 0
            ? <JournalEmpty variant="ticker" ticker={ticker} />
            : open.map((p) => <PositionCard key={String(p.id)} position={p} entries={p.entries} expanded />)
          }
        </CardContent>
      </Card>

      {closed.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Closed positions ({closed.length})</CardTitle></CardHeader>
          <CardContent>
            {closed.map((p) => <PositionCard key={String(p.id)} position={p} entries={p.entries} expanded />)}
          </CardContent>
        </Card>
      )}
    </article>
  );
}
