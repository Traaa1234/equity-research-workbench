import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { InsiderAggregate } from '@/lib/compute/insider-aggregate';

interface Props {
  ticker: string;
  aggregate: InsiderAggregate;
  hasAnyData: boolean;
}

function fmtShares(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M sh`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k sh`;
  return `${n.toLocaleString()} sh`;
}

function fmtDollars(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toLocaleString()}`;
}

export function InsiderCard({ ticker, aggregate, hasAnyData }: Props) {
  if (!hasAnyData) {
    return (
      <Card>
        <CardHeader><CardTitle>Insider activity</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No insider data fetched yet.{' '}
            <Link href={`/stock/${ticker}/insiders`} className="text-primary hover:underline">
              Visit the Insiders tab
            </Link>{' '}
            to refresh.
          </p>
        </CardContent>
      </Card>
    );
  }

  const netSign = aggregate.netShares > 0 ? 'text-green-600' : aggregate.netShares < 0 ? 'text-red-600' : '';
  const netPrefix = aggregate.netShares > 0 ? '+' : '';

  if (aggregate.buyCount === 0 && aggregate.sellCount === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>Insider activity</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          <p className="text-sm text-muted-foreground">No open-market activity in the last 90 days.</p>
          {aggregate.lastTransactionDate && (
            <p className="text-xs text-muted-foreground">
              Last filing: <span className="font-mono">{aggregate.lastTransactionDate}</span>
            </p>
          )}
          <div className="pt-2 text-right">
            <Link href={`/stock/${ticker}/insiders`} className="text-xs text-primary hover:underline">
              See full list →
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader><CardTitle>Insider activity</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-baseline justify-between">
          <span className="text-muted-foreground">90-day net</span>
          <span className={`font-mono tabular-nums ${netSign}`}>
            {netPrefix}{fmtShares(aggregate.netShares)}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-muted-foreground">≈</span>
          <span className={`font-mono tabular-nums ${netSign}`}>
            {netPrefix}{fmtDollars(aggregate.netDollarValue)}
          </span>
        </div>
        <div className="text-xs text-muted-foreground pt-1">
          <span className="text-green-600 font-medium">{aggregate.uniqueBuyers}</span> buyers · {' '}
          <span className="text-red-600 font-medium">{aggregate.uniqueSellers}</span> sellers
        </div>
        {aggregate.hasClusterBuy && (
          <div className="text-xs text-green-700 font-medium">
            ⚡ Cluster buy detected
          </div>
        )}
        {aggregate.lastTransactionDate && (
          <div className="text-xs text-muted-foreground">
            Last trade: <span className="font-mono">{aggregate.lastTransactionDate}</span>
          </div>
        )}
        <div className="pt-2 text-right">
          <Link href={`/stock/${ticker}/insiders`} className="text-xs text-primary hover:underline">
            See full list →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
