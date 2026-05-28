import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { HoldingsService } from '@/lib/services/holdings';
import { loadServerEnv } from '@/lib/env';
import { DashboardTabs } from '../_components/dashboard-tabs';
import { HoldingsView } from './_components/holdings-view';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;

interface PageProps {
  params: { ticker: string };
  searchParams: { period?: string };
}

export default async function HoldingsPage({ params, searchParams }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  const db = getServiceDb();
  const existing = await db.select().from(companies).where(eq(companies.ticker, ticker)).limit(1);
  if (existing.length === 0) notFound();

  const env = loadServerEnv();
  const svc = new HoldingsService({
    db,
    fdProvider: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY })
  });

  const period = searchParams.period && PERIOD_RE.test(searchParams.period) ? searchParams.period : undefined;

  const [holdings, aggregate, availablePeriods] = await Promise.all([
    svc.getList(ticker, period, 200),
    svc.getAggregate(ticker),
    svc.listAvailablePeriods(ticker)
  ]);

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">{existing[0]!.name}</p>
        </div>
        <DashboardTabs ticker={ticker} active="holdings" />
      </header>

      <Card>
        <CardHeader><CardTitle>Institutional Holdings (13F)</CardTitle></CardHeader>
        <CardContent>
          <HoldingsView
            ticker={ticker}
            holdings={holdings}
            aggregate={aggregate}
            availablePeriods={availablePeriods}
            selectedPeriod={period ?? availablePeriods[0] ?? null}
          />
        </CardContent>
      </Card>
    </article>
  );
}
