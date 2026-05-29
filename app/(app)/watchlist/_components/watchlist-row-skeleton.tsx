import { CellSkeleton } from './cells/cell-skeleton';

interface Props { ticker: string; }

export function WatchlistRowSkeleton({ ticker }: Props) {
  return (
    <li className="grid grid-cols-12 gap-3 items-baseline px-3 py-2 border-b border-border last:border-0">
      <span className="col-span-2 font-mono font-medium tabular-nums text-muted-foreground">
        {ticker}
      </span>
      <div className="col-span-2"><CellSkeleton /></div>
      <div className="col-span-2"><CellSkeleton /></div>
      <div className="col-span-2"><CellSkeleton /></div>
      <div className="col-span-2"><CellSkeleton /></div>
      <div className="col-span-2"><CellSkeleton /></div>
    </li>
  );
}
