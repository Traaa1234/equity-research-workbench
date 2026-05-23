import Link from 'next/link';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { WatchlistService } from '@/lib/services/watchlist';
import { SnapshotService } from '@/lib/services/snapshot';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';
import { WatchlistCard } from './_components/watchlist-card';
import { EmptyState } from './_components/empty-state';
import { AddTickerDialog } from './_components/add-ticker-dialog';

async function getWatchlistWithSnapshots(userId: string) {
  const db = getServiceDb();
  const env = loadServerEnv();
  const watchlistSvc = new WatchlistService(db);
  const snapshotSvc = new SnapshotService({
    db,
    primary: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY }),
    fallback: new YFinanceProvider(),
    redis: getRedisCache()
  });

  const entries = await watchlistSvc.list(userId);
  const enriched = await Promise.all(
    entries.map(async (e) => ({
      ticker: e.ticker,
      snapshot: await snapshotSvc.get(e.ticker).catch(() => null)
    }))
  );
  return enriched;
}

export default async function WatchlistPage() {
  const userId = await requireUserId();
  const items = await getWatchlistWithSnapshots(userId);

  if (items.length === 0) {
    return (
      <>
        <EmptyState />
        <AddTickerDialog />
      </>
    );
  }

  return (
    <>
      <section>
        <header className="mb-6 flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Watchlist</h1>
          <p className="text-sm text-muted-foreground">{items.length} ticker{items.length === 1 ? '' : 's'}</p>
        </header>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((item) => (
            <Link key={item.ticker} href={`/stock/${item.ticker}`}>
              <WatchlistCard ticker={item.ticker} snapshot={item.snapshot} />
            </Link>
          ))}
        </div>
      </section>
      <AddTickerDialog />
    </>
  );
}
