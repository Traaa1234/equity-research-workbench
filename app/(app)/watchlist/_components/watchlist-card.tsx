import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { SnapshotData } from '@/lib/providers/types';

function fmtCurrency(v: number | null) {
  if (v == null) return '—';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtMultiple(v: number | null) {
  if (v == null) return '—';
  return v.toFixed(1) + '×';
}

function fmtCompactCurrency(v: number | null) {
  if (v == null) return '—';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${v.toFixed(0)}`;
}

export function WatchlistCard({
  ticker,
  snapshot
}: {
  ticker: string;
  snapshot: SnapshotData | null;
}) {
  return (
    <Card className="hover:bg-accent/40 transition-colors">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-semibold">{ticker}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{fmtCurrency(snapshot?.price ?? null)}</div>
        <dl className="mt-4 grid grid-cols-2 gap-y-1 text-sm text-muted-foreground">
          <dt>Mkt cap</dt>
          <dd className="text-right tabular-nums">{fmtCompactCurrency(snapshot?.marketCap ?? null)}</dd>
          <dt>P/E</dt>
          <dd className="text-right tabular-nums">{fmtMultiple(snapshot?.pe ?? null)}</dd>
          <dt>P/S</dt>
          <dd className="text-right tabular-nums">{fmtMultiple(snapshot?.ps ?? null)}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}
