'use client';

import type { TechnicalResult } from '@/lib/compute/technical';
import { PriceChartWithSmas } from './price-chart-with-smas';
import { RsiPanel } from './rsi-panel';
import { MacdPanel } from './macd-panel';
import { SignalsList } from './signals-list';

interface Props {
  ticker: string;
  prices: { date: string; close: number }[];
  result: TechnicalResult;
}

function fmt(v: number | null, digits = 2): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

export function TechnicalView({ ticker, prices, result }: Props) {
  // Build the per-date row that all three charts share. Convert NaN → null so
  // Recharts renders gaps cleanly instead of dropping the segment.
  const rows = prices.map((p, i) => {
    const toNull = (v: number) => (Number.isFinite(v) ? v : null);
    return {
      date: p.date,
      close: p.close,
      sma20: toNull(result.sma20[i]!),
      sma50: toNull(result.sma50[i]!),
      sma200: toNull(result.sma200[i]!),
      rsi: toNull(result.rsi[i]!),
      macdLine: toNull(result.macdLine[i]!),
      macdSignal: toNull(result.macdSignal[i]!),
      macdHistogram: toNull(result.macdHistogram[i]!)
    };
  });

  const { current } = result;

  return (
    <div className="space-y-6">
      {/* Header strip with current readings */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm border-b pb-3">
        <div><span className="text-muted-foreground">Price</span> <span className="font-mono tabular-nums">{fmt(current.price)}</span></div>
        <div><span className="text-muted-foreground">SMA20</span> <span className="font-mono tabular-nums">{fmt(current.sma20)}</span></div>
        <div><span className="text-muted-foreground">SMA50</span> <span className="font-mono tabular-nums">{fmt(current.sma50)}</span></div>
        <div><span className="text-muted-foreground">SMA200</span> <span className="font-mono tabular-nums">{fmt(current.sma200)}</span></div>
        <div><span className="text-muted-foreground">RSI</span> <span className="font-mono tabular-nums">{fmt(current.rsi, 1)}</span></div>
        <div><span className="text-muted-foreground">MACD hist</span> <span className="font-mono tabular-nums">{fmt(current.macdHistogram, 3)}</span></div>
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2">Price + SMAs</h3>
        <PriceChartWithSmas data={rows} signals={result.signals} />
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2">RSI (14)</h3>
        <RsiPanel data={rows} />
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2">MACD (12, 26, 9)</h3>
        <MacdPanel data={rows} />
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2">Recent signals</h3>
        <SignalsList signals={result.signals} />
      </div>
    </div>
  );
}
