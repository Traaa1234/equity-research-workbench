import type { InsiderAggregate } from '@/lib/compute/insider-aggregate';

interface Props {
  aggregate: InsiderAggregate;
}

function fmtDollars(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toLocaleString()}`;
}

export function InsiderAggregatePanel({ aggregate }: Props) {
  if (aggregate.buyCount === 0 && aggregate.sellCount === 0) {
    return (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{aggregate.windowDays}-day summary</h2>
        <p className="text-sm text-muted-foreground">
          No open-market transactions in the window. Awards and option exercises (if any)
          are shown in the transaction list below.
        </p>
      </section>
    );
  }

  const netSign = aggregate.netShares > 0
    ? 'text-green-600'
    : aggregate.netShares < 0
      ? 'text-red-600'
      : '';
  const netPrefix = aggregate.netShares > 0 ? '+' : '';

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{aggregate.windowDays}-day summary</h2>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <span className="text-muted-foreground">Net shares</span>
        <span className={`font-mono tabular-nums ${netSign}`}>
          {netPrefix}{aggregate.netShares.toLocaleString()} ({netPrefix}{fmtDollars(aggregate.netDollarValue)})
        </span>
        <span className="text-muted-foreground">Open-market buys</span>
        <span>{aggregate.buyCount} txns across {aggregate.uniqueBuyers} insiders</span>
        <span className="text-muted-foreground">Open-market sells</span>
        <span>{aggregate.sellCount} txns across {aggregate.uniqueSellers} insiders</span>
        {aggregate.largestBuy && (
          <>
            <span className="text-muted-foreground">Largest buy</span>
            <span className="font-mono text-xs">
              {aggregate.largestBuy.name} · {aggregate.largestBuy.date} · {fmtDollars(aggregate.largestBuy.valueUsd)}
            </span>
          </>
        )}
        {aggregate.largestSell && (
          <>
            <span className="text-muted-foreground">Largest sell</span>
            <span className="font-mono text-xs">
              {aggregate.largestSell.name} · {aggregate.largestSell.date} · {fmtDollars(aggregate.largestSell.valueUsd)}
            </span>
          </>
        )}
      </div>

      {aggregate.hasClusterBuy && (
        <div className="rounded border border-green-700/30 bg-green-700/10 p-3 text-sm">
          <div className="font-medium text-green-700">⚡ Cluster buy detected</div>
          <div className="text-xs text-muted-foreground mt-1">
            Multiple insiders made open-market purchases within a 30-day window starting on{' '}
            {aggregate.clusterBuyDates.join(', ')}. Classic high-conviction signal.
          </div>
        </div>
      )}
    </section>
  );
}
