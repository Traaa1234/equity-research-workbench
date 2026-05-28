'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { SentimentAggregateBar } from './sentiment-aggregate-bar';
import { ArticleRow } from './article-row';
import type { SentimentLabel } from '@/lib/providers/types';

interface Article {
  id: string;
  ticker: string;
  url: string;
  title: string;
  source: string;
  publishedAt: string;       // serialized
  sentiment: SentimentLabel | null;
  confidence: number | null;
}

interface Aggregate {
  totalScored: number;
  bullish: number;
  neutral: number;
  bearish: number;
  score: number;
  lastRefresh: string | null;  // serialized
}

interface Props {
  ticker: string;
  articles: Article[];
  aggregate: Aggregate;
}

export function NewsView({ ticker, articles, aggregate }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    setLastSummary(null);
    setRefreshing(true);
    try {
      const res = await fetch(`/api/tickers/${ticker}/news`, { method: 'POST' });
      if (!res.ok) {
        if (res.status === 429) {
          setError('Refreshing too quickly — try again in a minute.');
        } else {
          const body = await res.json().catch(() => ({}));
          setError((body as { error?: string }).error ?? `Refresh failed (HTTP ${res.status})`);
        }
        return;
      }
      const summary = (await res.json()) as { fetched: number; newArticles: number; scored: number };
      setLastSummary(`Fetched ${summary.fetched} · ${summary.newArticles} new · ${summary.scored} scored`);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setRefreshing(false);
    }
  }

  const aggregateProps = {
    bullish: aggregate.bullish,
    neutral: aggregate.neutral,
    bearish: aggregate.bearish,
    totalScored: aggregate.totalScored,
    score: aggregate.score,
    lastRefresh: aggregate.lastRefresh ? new Date(aggregate.lastRefresh) : null
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <SentimentAggregateBar {...aggregateProps} />
        <Button onClick={refresh} disabled={refreshing || isPending}>
          {refreshing ? 'Refreshing…' : 'Refresh news'}
        </Button>
      </div>

      {lastSummary && (
        <div className="text-xs text-muted-foreground">{lastSummary}</div>
      )}
      {error && (
        <div className="text-xs text-red-600">{error}</div>
      )}

      <div>
        <h3 className="text-sm font-medium mb-2">Recent articles</h3>
        {articles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No news fetched yet. Click <strong>Refresh news</strong> to pull recent articles.
          </p>
        ) : (
          <ul className="space-y-0">
            {articles.map((a) => (
              <ArticleRow
                key={a.id}
                article={{
                  id: a.id,
                  title: a.title,
                  url: a.url,
                  source: a.source,
                  publishedAt: new Date(a.publishedAt),
                  sentiment: a.sentiment,
                  confidence: a.confidence
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
