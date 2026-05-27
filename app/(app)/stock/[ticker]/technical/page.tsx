import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { PricesService } from '@/lib/services/prices';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';
import { computeTechnical } from '@/lib/compute/technical';
import { TechnicalView } from './_components/technical-view';

interface PageProps {
  params: { ticker: string };
}

export default async function TechnicalPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  const env = loadServerEnv();
  const yf = new YFinanceProvider();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const pricesSvc = new PricesService({
    db: getServiceDb(),
    primary: yf,
    fallback: fd,
    redis: getRedisCache()
  });

  const prices = await pricesSvc.get(ticker, '1Y');
  const result = computeTechnical(prices);

  return (
    <div className="container py-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{ticker}</h1>
        <Tabs value="technical" className="hidden sm:block">
          <TabsList>
            <TabsTrigger value="overview" asChild>
              <Link href={`/stock/${ticker}`}>Overview</Link>
            </TabsTrigger>
            <TabsTrigger value="financials" asChild>
              <Link href={`/stock/${ticker}/financials`}>Financials</Link>
            </TabsTrigger>
            <TabsTrigger value="technical" asChild>
              <Link href={`/stock/${ticker}/technical`}>Technical</Link>
            </TabsTrigger>
            <TabsTrigger value="filings" asChild>
              <Link href={`/stock/${ticker}/filings`}>Filings</Link>
            </TabsTrigger>
            <TabsTrigger value="ask" asChild>
              <Link href={`/stock/${ticker}/ask`}>Ask</Link>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <Card>
        <CardHeader><CardTitle>Technical Analysis</CardTitle></CardHeader>
        <CardContent>
          <TechnicalView
            ticker={ticker}
            prices={prices.map(({ date, close }) => ({ date, close }))}
            result={result}
          />
        </CardContent>
      </Card>
    </div>
  );
}
