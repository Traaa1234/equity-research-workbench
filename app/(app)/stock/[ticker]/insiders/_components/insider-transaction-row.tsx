import { classifyTransaction, type TransactionClass } from '@/lib/compute/insider-aggregate';
import type { InsiderTrade } from '@/lib/services/insiders';

const GLYPHS: Record<TransactionClass, { symbol: string; color: string; label: string }> = {
  buy:      { symbol: '●', color: 'text-green-600',         label: 'BUY' },
  sell:     { symbol: '●', color: 'text-red-600',           label: 'SELL' },
  award:    { symbol: '◆', color: 'text-muted-foreground',  label: 'AWARD' },
  exercise: { symbol: '⬢', color: 'text-amber-600',         label: 'EXERCISE' },
  other:    { symbol: '○', color: 'text-muted-foreground',  label: 'OTHER' }
};

function fmtDollars(n: number | null): string {
  if (n == null) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toLocaleString()}`;
}

function fmtPrice(n: number | null): string {
  if (n == null) return '—';
  return `$${n.toFixed(2)}`;
}

export function InsiderTransactionRow({ trade }: { trade: InsiderTrade }) {
  const cls = classifyTransaction(trade.transactionType);
  const glyph = GLYPHS[cls];
  const titlePart = trade.insiderTitle
    ? trade.insiderTitle
    : trade.isBoardDirector
      ? 'Director'
      : '';

  return (
    <li className="grid grid-cols-12 items-baseline gap-3 border-b border-border py-2 text-sm last:border-0">
      <span className={`col-span-1 ${glyph.color} font-medium text-xs`}>
        {glyph.symbol} {glyph.label}
      </span>
      <span className="col-span-2 font-mono text-xs tabular-nums text-muted-foreground">
        {trade.transactionDate}
      </span>
      <span className="col-span-4 truncate">
        {trade.insiderName}
        {titlePart && <span className="text-muted-foreground"> ({titlePart})</span>}
      </span>
      <span className="col-span-2 text-right font-mono tabular-nums">
        {trade.shares.toLocaleString()} sh
      </span>
      <span className="col-span-1 text-right font-mono tabular-nums text-muted-foreground">
        {fmtPrice(trade.pricePerShare)}
      </span>
      <span className="col-span-2 text-right font-mono tabular-nums">
        {fmtDollars(trade.transactionValue)}
      </span>
    </li>
  );
}
