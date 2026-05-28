import type { HolderDelta } from '@/lib/compute/holdings-aggregate';
import type { SmartMoneyCategory } from '@/lib/compute/smart-money';

interface Props {
  investorId: string;
  investorName: string;
  shares: number;
  marketValue: number | null;
  sharesChange: number;
  sharesPrev: number | null;
  delta: HolderDelta;
  isSmartMoney: boolean;
  smartMoneyCategory: SmartMoneyCategory | null;
}

const GLYPHS: Record<HolderDelta, { symbol: string; color: string; label: string }> = {
  'new':       { symbol: '▲', color: 'text-green-600',         label: 'NEW' },
  'added':     { symbol: '▲', color: 'text-green-600',         label: 'ADDED' },
  'unchanged': { symbol: '●', color: 'text-muted-foreground',  label: 'HOLD' },
  'reduced':   { symbol: '▼', color: 'text-red-600',           label: 'REDUCED' },
  'sold-out':  { symbol: '✕', color: 'text-red-600',           label: 'SOLD OUT' }
};

function fmtShares(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function fmtDollars(n: number | null): string {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}k`;
  return `$${abs.toLocaleString()}`;
}

function pctChange(shares: number, prev: number | null): string {
  if (prev == null || prev === 0) return '—';
  const pct = ((shares - prev) / prev) * 100;
  if (pct > 0) return `+${pct.toFixed(0)}%`;
  return `${pct.toFixed(0)}%`;
}

export function HolderRow(props: Props) {
  const g = GLYPHS[props.delta];
  return (
    <li className="grid grid-cols-12 items-baseline gap-3 border-b border-border py-2 text-sm last:border-0">
      <span className={`col-span-1 ${g.color} font-medium text-xs`}>
        {g.symbol} {g.label}
      </span>
      <span className="col-span-4 truncate">
        {props.investorName}
        {props.isSmartMoney && props.smartMoneyCategory && (
          <span className="ml-2 text-xs text-amber-700 rounded border border-amber-700/30 px-1.5 py-0 lowercase">
            {props.smartMoneyCategory}
          </span>
        )}
      </span>
      <span className="col-span-2 text-right font-mono tabular-nums">
        {fmtShares(props.shares)} sh
      </span>
      <span className="col-span-2 text-right font-mono tabular-nums text-muted-foreground">
        {fmtDollars(props.marketValue)}
      </span>
      <span className={`col-span-1 text-right font-mono tabular-nums text-xs ${g.color}`}>
        {pctChange(props.shares, props.sharesPrev)}
      </span>
      <span className="col-span-2 text-right text-xs text-muted-foreground">
        {props.delta === 'unchanged' ? 'no change' : `prev ${props.sharesPrev != null ? fmtShares(props.sharesPrev) : '0'} sh`}
      </span>
    </li>
  );
}
