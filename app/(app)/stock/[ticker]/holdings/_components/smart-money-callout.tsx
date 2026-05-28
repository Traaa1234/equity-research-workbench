import type { HoldingsAggregate, HolderWithDelta } from '@/lib/compute/holdings-aggregate';

interface Props {
  aggregate: HoldingsAggregate;
}

function fmtShares(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function pctChangeString(h: HolderWithDelta): string {
  if (h.sharesPrev == null || h.sharesPrev === 0) return '+new';
  const pct = ((h.shares - h.sharesPrev) / h.sharesPrev) * 100;
  if (pct > 0) return `+${pct.toFixed(0)}%`;
  return `${pct.toFixed(0)}%`;
}

function moveRow(h: HolderWithDelta, accent: 'green' | 'red') {
  const color = accent === 'green' ? 'text-green-700' : 'text-red-700';
  const arrow = accent === 'green' ? '▲' : '▼';
  return (
    <li key={h.investorId} className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="flex items-baseline gap-2">
        <span className={`${color} font-bold`}>{arrow}</span>
        <span className="font-medium">{h.investorName}</span>
        {h.smartMoneyCategory && (
          <span className="text-xs text-muted-foreground rounded border border-border px-1.5 py-0 lowercase">
            {h.smartMoneyCategory}
          </span>
        )}
      </span>
      <span className="font-mono tabular-nums text-xs">
        {h.sharesPrev != null ? fmtShares(h.sharesPrev) : '0'} → {fmtShares(h.shares)} sh
        <span className={`ml-2 ${color}`}>{pctChangeString(h)}</span>
        <span className="ml-2 text-muted-foreground">{h.delta}</span>
      </span>
    </li>
  );
}

export function SmartMoneyCallout({ aggregate }: Props) {
  const { additions, reductions } = aggregate.smartMoneyMoves;
  if (additions.length + reductions.length === 0) return null;

  return (
    <section className="rounded border border-amber-700/30 bg-amber-700/5 p-4 space-y-3">
      <div className="font-medium text-amber-700">⚡ Smart-money moves this quarter</div>
      {additions.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Additions</div>
          <ul className="space-y-0">{additions.map((h) => moveRow(h, 'green'))}</ul>
        </div>
      )}
      {reductions.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Reductions</div>
          <ul className="space-y-0">{reductions.map((h) => moveRow(h, 'red'))}</ul>
        </div>
      )}
    </section>
  );
}
