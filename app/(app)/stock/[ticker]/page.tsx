import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { getRedisCache } from '@/lib/cache/redis';
import { SnapshotService } from '@/lib/services/snapshot';
import { PricesService } from '@/lib/services/prices';
import { FinancialsService } from '@/lib/services/financials';
import { loadServerEnv } from '@/lib/env';
import {
  buildReturnsSeries,
  buildGrowthSummary,
  buildValuationSummary
} from '@/lib/compute/dashboard';
import { SnapshotCard } from './_components/snapshot-card';
import { Sparkline } from './_components/sparkline';
import { ReturnsCard } from './_components/returns-card';
import { GrowthCard } from './_components/growth-card';
import { ValuationCard } from './_components/valuation-card';
import { EarningsCard } from './_components/earnings-card';
import { NotesEditor } from './_components/notes-editor';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface PageProps {
  params: { ticker: string };
}

export default async function StockPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  const db = getServiceDb();
  const existing = await db.select().from(companies).where(eq(companies.ticker, ticker)).limit(1);
  if (existing.length === 0) notFound();

  const env = loadServerEnv();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const redis = getRedisCache();
  const snapshotSvc = new SnapshotService({ db, primary: fd, fallback: yf, redis });
  const pricesSvc = new PricesService({ db, primary: fd, fallback: yf, redis });
  const financialsSvc = new FinancialsService({ db, primary: fd, fallback: yf, redis });

  const [snapshot, prices5Y, incomeBundle, balanceBundle, cashFlowBundle] = await Promise.all([
    snapshotSvc.get(ticker).catch(() => null),
    pricesSvc.get(ticker, '5Y').catch(() => []),
    financialsSvc.get(ticker, 'income', 'annual').catch(() => ({ ticker, statementType: 'income' as const, periodType: 'annual' as const, rows: [] })),
    financialsSvc.get(ticker, 'balance', 'annual').catch(() => ({ ticker, statementType: 'balance' as const, periodType: 'annual' as const, rows: [] })),
    financialsSvc.get(ticker, 'cash_flow', 'annual').catch(() => ({ ticker, statementType: 'cash_flow' as const, periodType: 'annual' as const, rows: [] }))
  ]);

  const returnsSeries = buildReturnsSeries(incomeBundle.rows, balanceBundle.rows);
  const growthSummary = buildGrowthSummary(incomeBundle.rows, cashFlowBundle.rows);
  const valuationSummary = buildValuationSummary(
    {
      pe: snapshot?.pe ?? null,
      ps: snapshot?.ps ?? null,
      pb: snapshot?.pb ?? null,
      evEbitda: snapshot?.evEbitda ?? null,
      peg: snapshot?.peg ?? null
    },
    incomeBundle.rows,
    prices5Y
  );

  const oneYearAgoMs = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const prices1Y = prices5Y.filter((p) => Date.parse(p.date) >= oneYearAgoMs);

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">{existing[0]!.name}</p>
        </div>
        <Tabs value="overview" className="hidden sm:block">
          <TabsList>
            <TabsTrigger value="overview" asChild>
              <Link href={`/stock/${ticker}`}>Overview</Link>
            </TabsTrigger>
            <TabsTrigger value="financials" asChild>
              <Link href={`/stock/${ticker}/financials`}>Financials</Link>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Snapshot</CardTitle></CardHeader>
          <CardContent>
            <SnapshotCard snapshot={snapshot} />
            <Sparkline data={prices1Y} />
          </CardContent>
        </Card>
        <ValuationCard valuation={valuationSummary} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <GrowthCard growth={growthSummary} />
        <EarningsCard ticker={ticker} />
      </div>

      <ReturnsCard series={returnsSeries} />

      <Card>
        <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
        <CardContent><NotesEditor ticker={ticker} /></CardContent>
      </Card>
    </article>
  );
}
