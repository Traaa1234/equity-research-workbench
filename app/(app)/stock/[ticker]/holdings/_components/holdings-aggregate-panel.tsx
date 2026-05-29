'use client';

import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from 'recharts';
import type { HoldingsAggregate } from '@/lib/compute/holdings-aggregate';

interface Props {
  aggregate: HoldingsAggregate;
}

function fmtDollars(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000_000) return `${sign}$${(abs / 1_000_000_000_000).toFixed(2)}T`;
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toLocaleString()}`;
}

export function HoldingsAggregatePanel({ aggregate }: Props) {
  if (!aggregate.currentPeriod) {
    return (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">13F summary</h2>
        <p className="text-sm text-muted-foreground">
          No quarterly data yet. Click Refresh to pull the latest 13F filings.
        </p>
      </section>
    );
  }

  const chartData = [...aggregate.breadthTrend].reverse().map((t) => ({
    period: t.period.slice(0, 7),
    holders: t.holders
  }));

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">
        Tracked investors <span className="text-sm font-normal text-muted-foreground">as of {aggregate.currentPeriod}</span>
      </h2>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <span className="text-muted-foreground">Tracked investors holding</span>
        <span className="font-mono tabular-nums">{aggregate.totalHolders.toLocaleString()} funds</span>
        <span className="text-muted-foreground" title="Concentration within our 45 tracked managers, not total float.">
          Top-10 share-of-tracked
        </span>
        <span className="font-mono tabular-nums">{(aggregate.top10Concentration * 100).toFixed(1)}%</span>
        <span className="text-muted-foreground">Total market value</span>
        <span className="font-mono tabular-nums">{fmtDollars(aggregate.totalMarketValue)}</span>
        <span className="text-muted-foreground">New positions</span>
        <span className="font-mono tabular-nums text-green-600">+{aggregate.newPositions}</span>
        <span className="text-muted-foreground">Exits</span>
        <span className="font-mono tabular-nums text-red-600">−{aggregate.exits}</span>
      </div>

      {chartData.length >= 2 && (
        <div className="pt-2">
          <div className="text-xs text-muted-foreground mb-1">Tracked investor breadth (out of 45, 8 quarters)</div>
          <div className="h-24">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <XAxis dataKey="period" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} width={40} />
                <Tooltip
                  contentStyle={{ fontSize: 12 }}
                  labelStyle={{ fontSize: 12 }}
                  formatter={(v) => typeof v === 'number' ? v.toLocaleString() : String(v ?? '—')}
                />
                <Line type="monotone" dataKey="holders" stroke="currentColor" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </section>
  );
}
