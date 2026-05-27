'use client';

import type { TechnicalResult } from '@/lib/compute/technical';

interface Props {
  ticker: string;
  prices: { date: string; close: number }[];
  result: TechnicalResult;
}

export function TechnicalView({ ticker, prices, result }: Props) {
  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        {ticker} · {prices.length} datapoints · {result.signals.length} signals · price {result.current.price}
      </div>
      <pre className="text-xs font-mono text-muted-foreground overflow-auto max-h-64 rounded border p-2">
        {JSON.stringify({ current: result.current, signals: result.signals.slice(0, 5) }, null, 2)}
      </pre>
    </div>
  );
}
