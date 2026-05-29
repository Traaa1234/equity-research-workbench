import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { PeersService } from '@/lib/services/peers';
import { DashboardTabs } from '../_components/dashboard-tabs';
import { PeersTable } from './_components/peers-table';
import { PeersEmpty } from './_components/peers-empty';
import { PeersSkeleton } from './_components/peers-skeleton';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface PageProps {
  params: { ticker: string };
}

async function PeersContent({ ticker }: { ticker: string }) {
  const db = getServiceDb();
  const env = loadServerEnv();
  const redis = getRedisCache();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const svc = new PeersService({ db, primary: yf, fallback: fd, redis });

  const result = await svc.getPeers(ticker, 5);

  if (result.fallback === 'target_missing') {
    return <PeersEmpty ticker={ticker} reason="target_missing" />;
  }
  return <PeersTable result={result} />;
}

export default async function PeersPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">Peer Comparison</p>
        </div>
        <DashboardTabs ticker={ticker} active="peers" />
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Comparable companies</CardTitle>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<PeersSkeleton />}>
            <PeersContent ticker={ticker} />
          </Suspense>
        </CardContent>
      </Card>
    </article>
  );
}
