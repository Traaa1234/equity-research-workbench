import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { getRedisCache } from '@/lib/cache/redis';
import { QwenProviderImpl } from '@/lib/providers/qwen';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
import { DiscoverService } from '@/lib/services/discover';
import { WatchlistTabs } from '../_components/watchlist-tabs';
import { DiscoverInput } from './_components/discover-input';
import { DiscoverFilterSummary } from './_components/discover-filter-summary';
import { DiscoverResultRow } from './_components/discover-result-row';
import { DiscoverEmptyState } from './_components/discover-empty-state';

interface PageProps {
  searchParams: { q?: string };
}

export default async function DiscoverPage({ searchParams }: PageProps) {
  await requireUserId();
  const q = searchParams.q?.trim() ?? '';

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Watchlist</h1>
        <WatchlistTabs active="discover" />
      </header>

      <div className="space-y-4">
        <DiscoverInput initialQuery={q} />

        {q === '' ? (
          <DiscoverEmptyState />
        ) : (
          <DiscoverResults query={q} />
        )}
      </div>
    </div>
  );
}

async function DiscoverResults({ query }: { query: string }) {
  const svc = new DiscoverService({
    db: getServiceDb(),
    qwenProvider: new QwenProviderImpl(),
    embeddingsProvider: new EmbeddingsProviderImpl(),
    redis: getRedisCache()
  });

  const parsed = await svc.parseQuery(query);
  const results = await svc.search(query, 20, parsed);

  return (
    <div className="space-y-4">
      <DiscoverFilterSummary parsed={parsed} />
      {results.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matches found.</p>
      ) : (
        <section>
          <div className="text-xs text-muted-foreground mb-2">
            {results.length} {results.length === 1 ? 'match' : 'matches'}
          </div>
          <ul className="space-y-0">
            {results.map((r) => (
              <DiscoverResultRow key={r.ticker} result={r} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
