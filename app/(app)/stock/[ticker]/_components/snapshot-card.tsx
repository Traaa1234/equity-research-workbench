import type { SnapshotData } from '@/lib/providers/types';

function fmtCurrency(v: number | null, fractionDigits = 2) {
  if (v == null) return '—';
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`;
}

function fmtMultiple(v: number | null) {
  if (v == null) return '—';
  return v.toFixed(2) + '×';
}

function fmtCompactCurrency(v: number | null) {
  if (v == null) return '—';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${v.toFixed(0)}`;
}

export function SnapshotCard({ snapshot }: { snapshot: SnapshotData | null }) {
  if (!snapshot) {
    return <p className="text-sm text-muted-foreground">No snapshot data.</p>;
  }
  const { price, marketCap, week52High, week52Low, pe, ps, pb, evEbitda, peg, asOf } = snapshot;
  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-4">
        <span className="text-4xl font-bold tabular-nums">{fmtCurrency(price)}</span>
        {(week52Low != null && week52High != null) && (
          <span className="text-sm text-muted-foreground">
            52-wk: {fmtCurrency(week52Low, 2)} – {fmtCurrency(week52High, 2)}
          </span>
        )}
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
        <Stat label="Mkt cap" value={fmtCompactCurrency(marketCap)} />
        <Stat label="P/E" value={fmtMultiple(pe)} />
        <Stat label="P/S" value={fmtMultiple(ps)} />
        <Stat label="P/B" value={fmtMultiple(pb)} />
        <Stat label="EV/EBITDA" value={fmtMultiple(evEbitda)} />
        <Stat label="PEG" value={fmtMultiple(peg)} />
      </dl>
      <p className="text-xs text-muted-foreground">
        As of {new Date(asOf).toLocaleString()}
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
