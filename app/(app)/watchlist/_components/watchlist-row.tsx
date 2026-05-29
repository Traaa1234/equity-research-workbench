import { Suspense } from 'react';
import Link from 'next/link';
import { SnapshotCell } from './cells/snapshot-cell';
import { TechnicalCell } from './cells/technical-cell';
import { NewsCell } from './cells/news-cell';
import { InsidersCell } from './cells/insiders-cell';
import { FilingsCell } from './cells/filings-cell';
import { CellSkeleton } from './cells/cell-skeleton';

interface Props { ticker: string; }

export function WatchlistRow({ ticker }: Props) {
  return (
    <li className="grid grid-cols-12 gap-3 items-baseline px-3 py-2 border-b border-border last:border-0 hover:bg-muted/50">
      <Link
        href={`/stock/${ticker}`}
        className="col-span-2 font-mono font-medium tabular-nums hover:text-primary"
      >
        {ticker}
      </Link>
      <div className="col-span-2">
        <Suspense fallback={<CellSkeleton />}>
          <SnapshotCell ticker={ticker} />
        </Suspense>
      </div>
      <div className="col-span-2">
        <Suspense fallback={<CellSkeleton />}>
          <TechnicalCell ticker={ticker} />
        </Suspense>
      </div>
      <div className="col-span-2">
        <Suspense fallback={<CellSkeleton />}>
          <NewsCell ticker={ticker} />
        </Suspense>
      </div>
      <div className="col-span-2">
        <Suspense fallback={<CellSkeleton />}>
          <InsidersCell ticker={ticker} />
        </Suspense>
      </div>
      <div className="col-span-2">
        <Suspense fallback={<CellSkeleton />}>
          <FilingsCell ticker={ticker} />
        </Suspense>
      </div>
    </li>
  );
}
