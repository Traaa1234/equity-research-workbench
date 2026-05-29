import { Suspense } from 'react';
import { getServiceDb } from '@/lib/db/client';
import { loadServerEnv } from '@/lib/env';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { QwenProviderImpl } from '@/lib/providers/qwen';
import { InsidersService } from '@/lib/services/insiders';
import { NewsService } from '@/lib/services/news';
import { WatchlistRow } from './watchlist-row';
import { WatchlistRowSkeleton } from './watchlist-row-skeleton';
import { WatchlistRowMobile } from './watchlist-row-mobile';
import { SortToggle } from './sort-toggle';

type SortMode = 'default' | 'insider' | 'news' | 'cluster';

interface Props {
  tickers: string[];
  sort?: SortMode;
}

async function rankSignals(tickers: string[]): Promise<Map<string, {
  hasClusterBuy: boolean;
  insiderActivity: number;
  newsCount7d: number;
}>> {
  const db = getServiceDb();
  const env = loadServerEnv();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const qwen = new QwenProviderImpl();
  const insidersSvc = new InsidersService({ db, fdProvider: fd });
  const newsSvc = new NewsService({ db, fdProvider: fd, qwenProvider: qwen });
  const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const result = new Map<string, { hasClusterBuy: boolean; insiderActivity: number; newsCount7d: number }>();
  await Promise.all(tickers.map(async (t) => {
    const [agg, articles] = await Promise.all([
      insidersSvc.getAggregate(t, 90).catch(() => null),
      newsSvc.getList(t, 50).catch(() => [])
    ]);
    const recent = articles.filter((a) => a.publishedAt.getTime() >= cutoffMs);
    result.set(t, {
      hasClusterBuy: agg?.hasClusterBuy ?? false,
      insiderActivity: Math.abs(agg?.netShares ?? 0),
      newsCount7d: recent.length
    });
  }));
  return result;
}

async function sortTickers(tickers: string[], sort: SortMode): Promise<string[]> {
  if (sort === 'default') {
    return [...tickers].sort((a, b) => a.localeCompare(b));
  }
  const signals = await rankSignals(tickers);
  const withSignal: string[] = [];
  const withoutSignal: string[] = [];
  for (const t of tickers) {
    const s = signals.get(t);
    let hit = false;
    if (s) {
      if (sort === 'cluster') hit = s.hasClusterBuy;
      else if (sort === 'insider') hit = s.insiderActivity > 0;
      else if (sort === 'news') hit = s.newsCount7d > 0;
    }
    (hit ? withSignal : withoutSignal).push(t);
  }
  withSignal.sort((a, b) => a.localeCompare(b));
  withoutSignal.sort((a, b) => a.localeCompare(b));
  return [...withSignal, ...withoutSignal];
}

export async function WatchlistTable({ tickers, sort = 'default' }: Props) {
  const ordered = await sortTickers(tickers, sort);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <SortToggle />
      </div>

      {/* Desktop / lg+ */}
      <div className="hidden lg:block border border-border rounded">
        <header className="grid grid-cols-12 gap-3 px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border">
          <span className="col-span-2">Ticker</span>
          <span className="col-span-2 text-right">Snapshot</span>
          <span className="col-span-2 text-center">Tech</span>
          <span className="col-span-2 text-center">News</span>
          <span className="col-span-2 text-center">Insiders</span>
          <span className="col-span-2 text-center">Filings</span>
        </header>
        <ul>
          {ordered.map((t) => (
            <Suspense key={t} fallback={<WatchlistRowSkeleton ticker={t} />}>
              <WatchlistRow ticker={t} />
            </Suspense>
          ))}
        </ul>
      </div>

      {/* Mobile / <lg */}
      <ul className="lg:hidden">
        {ordered.map((t) => (
          <Suspense key={t} fallback={<div className="rounded border border-border p-3 mb-2"><div className="font-mono font-medium text-muted-foreground">{t}</div></div>}>
            <WatchlistRowMobile ticker={t} />
          </Suspense>
        ))}
      </ul>
    </div>
  );
}
