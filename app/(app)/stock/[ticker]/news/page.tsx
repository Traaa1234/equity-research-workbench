import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DashboardTabs } from '../_components/dashboard-tabs';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { QwenProviderImpl } from '@/lib/providers/qwen';
import { NewsService } from '@/lib/services/news';
import { loadServerEnv } from '@/lib/env';
import { NewsView } from './_components/news-view';

interface PageProps {
  params: { ticker: string };
}

export default async function NewsPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  const env = loadServerEnv();
  const svc = new NewsService({
    db: getServiceDb(),
    fdProvider: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY }),
    qwenProvider: new QwenProviderImpl()
  });

  const [articles, aggregate] = await Promise.all([
    svc.getList(ticker, 50),
    svc.getAggregate(ticker, 20)
  ]);

  // Serialize Date fields for client component props
  const serializedArticles = articles.map((a) => ({
    id: a.id,
    ticker: a.ticker,
    url: a.url,
    title: a.title,
    source: a.source,
    publishedAt: a.publishedAt.toISOString(),
    sentiment: a.sentiment,
    confidence: a.confidence
  }));
  const serializedAggregate = {
    totalScored: aggregate.totalScored,
    bullish: aggregate.bullish,
    neutral: aggregate.neutral,
    bearish: aggregate.bearish,
    score: aggregate.score,
    lastRefresh: aggregate.lastRefresh ? aggregate.lastRefresh.toISOString() : null
  };

  return (
    <div className="container py-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{ticker}</h1>
        <DashboardTabs ticker={ticker} active="news" />
      </div>

      <Card>
        <CardHeader><CardTitle>News &amp; Sentiment</CardTitle></CardHeader>
        <CardContent>
          <NewsView ticker={ticker} articles={serializedArticles} aggregate={serializedAggregate} />
        </CardContent>
      </Card>
    </div>
  );
}
