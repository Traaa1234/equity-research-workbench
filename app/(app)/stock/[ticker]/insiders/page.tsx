import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { InsidersService } from '@/lib/services/insiders';
import { loadServerEnv } from '@/lib/env';
import { DashboardTabs } from '../_components/dashboard-tabs';
import { InsidersView } from './_components/insiders-view';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface PageProps {
  params: { ticker: string };
}

export default async function InsidersPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  const db = getServiceDb();
  const existing = await db.select().from(companies).where(eq(companies.ticker, ticker)).limit(1);
  if (existing.length === 0) notFound();

  const env = loadServerEnv();
  const svc = new InsidersService({
    db,
    fdProvider: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY })
  });

  const [transactions, aggregate] = await Promise.all([
    svc.getList(ticker, 100),
    svc.getAggregate(ticker, 90)
  ]);

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">{existing[0]!.name}</p>
        </div>
        <DashboardTabs ticker={ticker} active="insiders" />
      </header>

      <Card>
        <CardHeader><CardTitle>Insider Activity</CardTitle></CardHeader>
        <CardContent>
          <InsidersView ticker={ticker} transactions={transactions} aggregate={aggregate} />
        </CardContent>
      </Card>
    </article>
  );
}
