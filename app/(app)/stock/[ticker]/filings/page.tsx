import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { companies } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { FilingsEmptyState } from '../_components/filings-empty-state';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface PageProps { params: { ticker: string }; }

export default async function FilingsPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  const db = getServiceDb();
  const company = await db.select().from(companies).where(eq(companies.ticker, ticker)).limit(1);
  if (company.length === 0) notFound();

  const svc = new FilingsService({ db, provider: new SecEdgarProviderImpl() });
  const { filings: filingsList, needsIngest } = await svc.getList(ticker);

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">{company[0]!.name}</p>
        </div>
        <Tabs value="filings" className="hidden sm:block">
          <TabsList>
            <TabsTrigger value="overview" asChild><Link href={`/stock/${ticker}`}>Overview</Link></TabsTrigger>
            <TabsTrigger value="financials" asChild><Link href={`/stock/${ticker}/financials`}>Financials</Link></TabsTrigger>
            <TabsTrigger value="filings" asChild><Link href={`/stock/${ticker}/filings`}>Filings</Link></TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      {needsIngest ? (
        <FilingsEmptyState ticker={ticker} />
      ) : (
        <Card>
          <CardHeader><CardTitle>SEC Filings (last 5 years)</CardTitle></CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {filingsList.map((f) => (
                <li key={f.accessionNo} className="py-3 flex items-baseline justify-between">
                  <div>
                    <Link
                      href={`/stock/${ticker}/filings/${f.accessionNo}`}
                      className="font-medium hover:underline"
                    >
                      {f.formType} — filed {f.filingDate}
                    </Link>
                    {f.periodEnd && (
                      <span className="ml-3 text-sm text-muted-foreground">period ending {f.periodEnd}</span>
                    )}
                  </div>
                  <a
                    href={f.primaryDocUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    open on SEC &#8599;
                  </a>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </article>
  );
}
