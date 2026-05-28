import { notFound } from 'next/navigation';
import Link from 'next/link';
import { DashboardTabs } from '../_components/dashboard-tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { FinancialsService } from '@/lib/services/financials';
import { loadServerEnv } from '@/lib/env';
import { FinancialsTable } from '../_components/financials-table';
import { RevenueChart } from '../_components/revenue-chart';
import { MarginChart } from '../_components/margin-chart';
import { FCFChart } from '../_components/fcf-chart';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const PERIODS = ['annual', 'quarterly'] as const;
type Period = (typeof PERIODS)[number];

interface PageProps {
  params: { ticker: string };
  searchParams: { period?: string };
}

export default async function FinancialsPage({ params, searchParams }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  const period: Period = PERIODS.includes(searchParams.period as Period)
    ? (searchParams.period as Period)
    : 'annual';

  const db = getServiceDb();
  const existing = await db.select().from(companies).where(eq(companies.ticker, ticker)).limit(1);
  if (existing.length === 0) notFound();

  const env = loadServerEnv();
  const svc = new FinancialsService({
    db,
    primary: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY }),
    fallback: new YFinanceProvider(),
    redis: getRedisCache()
  });

  const [income, balance, cashFlow] = await Promise.all([
    svc.get(ticker, 'income', period).catch(() => ({ ticker, statementType: 'income' as const, periodType: period, rows: [] })),
    svc.get(ticker, 'balance', period).catch(() => ({ ticker, statementType: 'balance' as const, periodType: period, rows: [] })),
    svc.get(ticker, 'cash_flow', period).catch(() => ({ ticker, statementType: 'cash_flow' as const, periodType: period, rows: [] }))
  ]);

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">{existing[0]!.name}</p>
        </div>
        <DashboardTabs ticker={ticker} active="financials" />
      </header>

      <Tabs value={period}>
        <TabsList>
          <TabsTrigger value="annual" asChild>
            <Link href={`/stock/${ticker}/financials?period=annual`}>Annual</Link>
          </TabsTrigger>
          <TabsTrigger value="quarterly" asChild>
            <Link href={`/stock/${ticker}/financials?period=quarterly`}>Quarterly</Link>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader><CardTitle>Revenue</CardTitle></CardHeader>
          <CardContent><RevenueChart income={income} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Margins</CardTitle></CardHeader>
          <CardContent><MarginChart income={income} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Free cash flow</CardTitle></CardHeader>
          <CardContent><FCFChart cashFlow={cashFlow} /></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Income statement ({period})</CardTitle></CardHeader>
        <CardContent><FinancialsTable bundle={income} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Balance sheet ({period})</CardTitle></CardHeader>
        <CardContent><FinancialsTable bundle={balance} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Cash flow ({period})</CardTitle></CardHeader>
        <CardContent><FinancialsTable bundle={cashFlow} /></CardContent>
      </Card>
    </article>
  );
}
