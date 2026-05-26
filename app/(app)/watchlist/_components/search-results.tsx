import { eq, count } from 'drizzle-orm';
import { Card, CardContent } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { watchlist, chunkEmbeddings } from '@/lib/db/schema';
import { SearchService } from '@/lib/services/search';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
import { RateLimitError, ValidationError, ProviderError } from '@/lib/providers/types';
import { SearchResultCard } from './search-result-card';

interface Props {
  q: string;
}

export async function SearchResults({ q }: Props) {
  const userId = await requireUserId();
  const db = getServiceDb();

  const watchlistCount = await db.select({ c: count() }).from(watchlist).where(eq(watchlist.userId, userId));
  if ((watchlistCount[0]?.c ?? 0) === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          Add tickers to your watchlist to search across their filings.
        </CardContent>
      </Card>
    );
  }

  const embCount = await db.select({ c: count() }).from(chunkEmbeddings).limit(1);
  if ((embCount[0]?.c ?? 0) === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          No filings have been indexed yet. Click &quot;Load filings&quot; on a ticker&apos;s page first.
        </CardContent>
      </Card>
    );
  }

  const svc = new SearchService({ db, provider: new EmbeddingsProviderImpl() });

  try {
    const results = await svc.searchAcrossWatchlist({ userId, query: q });
    if (results.length === 0) {
      return (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            No matches found for &quot;{q}&quot;. Try different terms or broaden your watchlist.
          </CardContent>
        </Card>
      );
    }
    return (
      <section className="space-y-3" aria-label={`Search results for ${q}`}>
        <p className="text-sm text-muted-foreground">
          {results.length} {results.length === 1 ? 'result' : 'results'} for &quot;{q}&quot;
        </p>
        {results.map((r) => (
          <SearchResultCard
            key={`${r.accessionNo}-${r.sectionKey}-${r.subChunkIndex}`}
            ticker={r.ticker}
            companyName={r.companyName}
            accessionNo={r.accessionNo}
            formType={r.formType}
            filingDate={r.filingDate}
            sectionKey={r.sectionKey}
            sectionTitle={r.sectionTitle}
            snippet={r.snippet}
            distance={r.distance}
          />
        ))}
      </section>
    );
  } catch (err) {
    const isRate = err instanceof RateLimitError;
    const isValidation = err instanceof ValidationError;
    const isProvider = err instanceof ProviderError;
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          {isValidation && 'Search query invalid.'}
          {isRate && 'Search service is rate-limited. Try again in a moment.'}
          {isProvider && 'Search service is temporarily unavailable.'}
          {!isValidation && !isRate && !isProvider && 'Could not complete search.'}
        </CardContent>
      </Card>
    );
  }
}
