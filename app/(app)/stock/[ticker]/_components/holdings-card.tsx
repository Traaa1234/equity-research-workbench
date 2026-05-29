import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { HoldingsAggregate } from '@/lib/compute/holdings-aggregate';

interface Props {
  ticker: string;
  aggregate: HoldingsAggregate;
  hasAnyData: boolean;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export function HoldingsCard({ ticker, aggregate, hasAnyData }: Props) {
  if (!hasAnyData) {
    return (
      <Card>
        <CardHeader><CardTitle>Tracked investor holdings</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No tracked investor data yet.{' '}
            <Link href={`/stock/${ticker}/holdings`} className="text-primary hover:underline">
              Visit the Holdings tab
            </Link>{' '}
            to refresh.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!aggregate.currentPeriod) {
    return (
      <Card>
        <CardHeader><CardTitle>Tracked investor holdings</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          <p className="text-sm text-muted-foreground">No quarterly data yet.</p>
          <div className="pt-2 text-right">
            <Link href={`/stock/${ticker}/holdings`} className="text-xs text-primary hover:underline">
              See full list →
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  const smartMoneyTotal = aggregate.smartMoneyMoves.additions.length + aggregate.smartMoneyMoves.reductions.length;

  return (
    <Card>
      <CardHeader><CardTitle>Tracked investor holdings</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-baseline justify-between">
          <span className="text-muted-foreground">Tracked holding</span>
          <span className="font-mono tabular-nums">{aggregate.totalHolders} of 45 tracked</span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-muted-foreground">Top-10 stake</span>
          <span className="font-mono tabular-nums">{fmtPct(aggregate.top10Concentration)}</span>
        </div>
        <div className="text-xs text-muted-foreground pt-1">
          <span className="text-green-600 font-medium">+{aggregate.newPositions}</span> new ·{' '}
          <span className="text-red-600 font-medium">−{aggregate.exits}</span> exits
        </div>
        {smartMoneyTotal > 0 && (
          <div className="text-xs text-amber-700 font-medium">
            ⚡ {smartMoneyTotal} smart-money {smartMoneyTotal === 1 ? 'move' : 'moves'}
            <span className="text-muted-foreground font-normal">
              {' '}({aggregate.smartMoneyMoves.additions.length} additions,{' '}
              {aggregate.smartMoneyMoves.reductions.length} reductions)
            </span>
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          As of <span className="font-mono">{aggregate.currentPeriod}</span>
        </div>
        <div className="pt-2 text-right">
          <Link href={`/stock/${ticker}/holdings`} className="text-xs text-primary hover:underline">
            See full list →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
