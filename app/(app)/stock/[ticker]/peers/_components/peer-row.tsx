import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { PeerRow as PeerRowData } from '@/lib/services/peers';
import { PeerCell } from './peer-cell';

interface Props {
  row: PeerRowData;
  allRows: PeerRowData[];   // for quartile context (target + peers)
  emphasis?: 'target' | 'peer';
}

export function PeerRow({ row, allRows, emphasis = 'peer' }: Props) {
  const marketCaps = allRows.map((r) => r.marketCap);
  const pes        = allRows.map((r) => r.pe);
  const evEbitdas  = allRows.map((r) => r.evEbitda);
  const revGrowths = allRows.map((r) => r.revGrowthYoy);
  const grossMargs = allRows.map((r) => r.grossMargin);
  const roes       = allRows.map((r) => r.roe);
  const fScores    = allRows.map((r) => r.fScore);

  return (
    <li
      className={cn(
        'grid grid-cols-12 gap-3 items-baseline px-3 py-2 border-b border-border last:border-0 hover:bg-muted/50',
        emphasis === 'target' && 'bg-muted/30 font-medium'
      )}
    >
      <Link
        href={`/stock/${row.ticker}`}
        className="col-span-2 font-mono font-medium tabular-nums hover:text-primary"
      >
        {row.ticker}
      </Link>
      <div className="col-span-2 truncate text-sm" title={row.name}>{row.name}</div>
      <div className="col-span-1 text-xs text-muted-foreground">{row.country ?? '—'}</div>

      <div className="col-span-1 text-right">
        <PeerCell value={row.marketCap} allValues={marketCaps} direction="higher-is-better" format="currency" />
      </div>
      <div className="col-span-1 text-right">
        <PeerCell value={row.pe} allValues={pes} direction="lower-is-better" format="multiple" />
      </div>
      <div className="col-span-1 text-right">
        <PeerCell value={row.evEbitda} allValues={evEbitdas} direction="lower-is-better" format="multiple" />
      </div>
      <div className="col-span-1 text-right">
        <PeerCell value={row.revGrowthYoy} allValues={revGrowths} direction="higher-is-better" format="percent" />
      </div>
      <div className="col-span-1 text-right">
        <PeerCell value={row.grossMargin} allValues={grossMargs} direction="higher-is-better" format="percent" />
      </div>
      <div className="col-span-1 text-right">
        <PeerCell value={row.roe} allValues={roes} direction="higher-is-better" format="percent" />
      </div>
      <div className="col-span-1 text-right">
        <PeerCell value={row.fScore} allValues={fScores} direction="higher-is-better" format="integer" />
      </div>
    </li>
  );
}
