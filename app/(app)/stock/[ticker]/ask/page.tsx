// app/(app)/stock/[ticker]/ask/page.tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { AskPanel } from '@/app/(app)/_components/ask-panel';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface PageProps { params: { ticker: string }; }

export default async function TickerAskPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  const db = getServiceDb();
  const company = await db.select().from(companies).where(eq(companies.ticker, ticker)).limit(1);
  if (company.length === 0) notFound();

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">{company[0]!.name}</p>
        </div>
        <Tabs value="ask" className="hidden sm:block">
          <TabsList>
            <TabsTrigger value="overview" asChild><Link href={`/stock/${ticker}`}>Overview</Link></TabsTrigger>
            <TabsTrigger value="financials" asChild><Link href={`/stock/${ticker}/financials`}>Financials</Link></TabsTrigger>
            <TabsTrigger value="filings" asChild><Link href={`/stock/${ticker}/filings`}>Filings</Link></TabsTrigger>
            <TabsTrigger value="ask" asChild><Link href={`/stock/${ticker}/ask`}>Ask</Link></TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      <AskPanel
        scope={{ type: 'ticker', ticker }}
        placeholder={`🔍 Ask a question about ${ticker}'s filings…`}
        examples={[
          `What did ${ticker} say about AI capex in their most recent 10-K?`,
          `How has the China tariff risk language changed quarter-over-quarter?`,
          `Summarize ${ticker}'s key risk factors`
        ]}
      />
    </article>
  );
}
