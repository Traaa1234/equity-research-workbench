import { Suspense } from 'react';
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
import { SearchBar } from './_components/search-bar';
import { SearchResults } from './_components/search-results';
import { SearchSkeleton } from './_components/search-skeleton';
import { WatchlistTabs } from './_components/watchlist-tabs';
import { WatchlistTable } from './_components/watchlist-table';
import { AskPanel } from '@/app/(app)/_components/ask-panel';

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

interface PageProps {
  searchParams: { q?: string; mode?: string; tab?: string; sort?: string };
}

type TabMode = 'rollup' | 'list' | 'search' | 'ask';
const VALID_TABS = new Set<TabMode>(['rollup', 'list', 'search', 'ask']);

type SortMode = 'default' | 'insider' | 'news' | 'cluster';
const VALID_SORTS = new Set<SortMode>(['default', 'insider', 'news', 'cluster']);

export default async function WatchlistPage({ searchParams }: PageProps) {
  const userId = await requireUserId();
  const items = await getWatchlistWithSnapshots(userId);

  const tab: TabMode = (VALID_TABS.has(searchParams.tab as TabMode) ? searchParams.tab : 'rollup') as TabMode;
  const sort: SortMode = (VALID_SORTS.has(searchParams.sort as SortMode) ? searchParams.sort : 'default') as SortMode;

  if (items.length === 0) {
    return (
      <>
        <div className="space-y-4 mb-6">
          <WatchlistTabs active={tab} />

          {searchParams.mode === 'ask' ? (
            <AskPanel
              scope={{ type: 'watchlist' }}
              placeholder="🔍 Ask a question about your watchlist's filings…"
              examples={[
                'Which of my companies have China supply exposure?',
                'Compare AI infrastructure spending across my watchlist',
                'Who flagged regulatory risk in their latest 10-K?'
              ]}
            />
          ) : (
            <>
              <SearchBar />
              <p className="text-xs text-muted-foreground">
                Examples: &quot;China tariff exposure&quot;, &quot;AI infrastructure spending&quot;, &quot;customer concentration risk&quot;
              </p>
              {searchParams.q && (
                <Suspense fallback={<SearchSkeleton />}>
                  <SearchResults q={searchParams.q} />
                </Suspense>
              )}
            </>
          )}
        </div>
        <EmptyState />
        <AddTickerDialog />
      </>
    );
  }

  if (tab === 'rollup') {
    return (
      <div className="space-y-4">
        <header className="flex items-baseline justify-between">
          <h1 className="text-2xl font-bold tracking-tight">Watchlist</h1>
          <WatchlistTabs active="rollup" />
        </header>
        <WatchlistTable tickers={items.map((i) => i.ticker)} sort={sort} />
      </div>
    );
  }

  return (
    <>
      <section>
        <header className="mb-6 flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Watchlist</h1>
          <p className="text-sm text-muted-foreground">{items.length} ticker{items.length === 1 ? '' : 's'}</p>
        </header>
        <div className="space-y-4 mb-6">
          <WatchlistTabs active={tab} />

          {searchParams.mode === 'ask' ? (
            <AskPanel
              scope={{ type: 'watchlist' }}
              placeholder="🔍 Ask a question about your watchlist's filings…"
              examples={[
                'Which of my companies have China supply exposure?',
                'Compare AI infrastructure spending across my watchlist',
                'Who flagged regulatory risk in their latest 10-K?'
              ]}
            />
          ) : (
            <>
              <SearchBar />
              <p className="text-xs text-muted-foreground">
                Examples: &quot;China tariff exposure&quot;, &quot;AI infrastructure spending&quot;, &quot;customer concentration risk&quot;
              </p>
              {searchParams.q && (
                <Suspense fallback={<SearchSkeleton />}>
                  <SearchResults q={searchParams.q} />
                </Suspense>
              )}
            </>
          )}
        </div>
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
