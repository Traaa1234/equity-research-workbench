import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { SectionNav } from './_components/section-nav';
import { FilingBriefing } from './_components/filing-briefing';
import { BriefingSkeleton } from './_components/briefing-skeleton';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;

interface PageProps { params: { ticker: string; accession: string }; }

export default async function FilingPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();
  if (!ACCESSION_RE.test(params.accession)) notFound();

  const svc = new FilingsService({ db: getServiceDb(), provider: new SecEdgarProviderImpl() });
  const result = await svc.getFiling(ticker, params.accession);
  if (!result) notFound();

  const { filing, sections } = result;

  return (
    <article className="space-y-6">
      <header className="space-y-2">
        <Link
          href={`/stock/${ticker}/filings`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← back to {ticker} filings
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">
          {ticker} {filing.formType}
        </h1>
        <p className="text-sm text-muted-foreground">
          Filed {filing.filingDate}
          {filing.periodEnd && <> · period ending {filing.periodEnd}</>}
          {' · '}
          <a
            href={filing.primaryDocUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground"
          >
            open original on SEC ↗
          </a>
        </p>
      </header>

      <Suspense fallback={<BriefingSkeleton />}>
        <FilingBriefing ticker={ticker} accession={filing.accessionNo} />
      </Suspense>

      {sections.length === 0 ? (
        <Card>
          <CardContent className="py-6">
            <p className="text-sm text-muted-foreground">
              No sections parsed for this filing. The parser may not have recognized
              this filing&apos;s structure.
            </p>
          </CardContent>
        </Card>
      ) : (
        <SectionNav ticker={ticker} accession={filing.accessionNo} sections={sections} />
      )}
    </article>
  );
}
