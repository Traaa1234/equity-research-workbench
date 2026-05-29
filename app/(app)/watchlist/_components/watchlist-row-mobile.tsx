import { Suspense } from 'react';
import Link from 'next/link';
import { SnapshotCell } from './cells/snapshot-cell';
import { TechnicalCell } from './cells/technical-cell';
import { NewsCell } from './cells/news-cell';
import { InsidersCell } from './cells/insiders-cell';
import { FilingsCell } from './cells/filings-cell';
import { CellSkeleton } from './cells/cell-skeleton';

interface Props { ticker: string; }

export function WatchlistRowMobile({ ticker }: Props) {
  return (
    <li className="rounded border border-border p-3 mb-2 last:mb-0">
      <Link href={`/stock/${ticker}`} className="font-mono font-medium text-lg hover:text-primary">
        {ticker}
      </Link>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-muted-foreground">Snapshot</div>
          <Suspense fallback={<CellSkeleton />}>
            <SnapshotCell ticker={ticker} />
          </Suspense>
        </div>
        <div>
          <div className="text-muted-foreground">Tech</div>
          <Suspense fallback={<CellSkeleton />}>
            <TechnicalCell ticker={ticker} />
          </Suspense>
        </div>
        <div>
          <div className="text-muted-foreground">News</div>
          <Suspense fallback={<CellSkeleton />}>
            <NewsCell ticker={ticker} />
          </Suspense>
        </div>
        <div>
          <div className="text-muted-foreground">Insiders</div>
          <Suspense fallback={<CellSkeleton />}>
            <InsidersCell ticker={ticker} />
          </Suspense>
        </div>
        <div className="col-span-2">
          <div className="text-muted-foreground">Filings</div>
          <Suspense fallback={<CellSkeleton />}>
            <FilingsCell ticker={ticker} />
          </Suspense>
        </div>
      </div>
    </li>
  );
}
