import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { PeerRow as PeerRowData } from '@/lib/services/peers';
import { PeerCell } from './peer-cell';

interface Props {
  row: PeerRowData;
  allRows: PeerRowData[];
  emphasis?: 'target' | 'peer';
}

export function PeerRowMobile({ row, allRows, emphasis = 'peer' }: Props) {
  const marketCaps = allRows.map((r) => r.marketCap);
  const pes        = allRows.map((r) => r.pe);
  const evEbitdas  = allRows.map((r) => r.evEbitda);
  const revGrowths = allRows.map((r) => r.revGrowthYoy);
  const grossMargs = allRows.map((r) => r.grossMargin);
  const roes       = allRows.map((r) => r.roe);
  const fScores    = allRows.map((r) => r.fScore);

  return (
    <li className={cn('rounded border border-border p-3 mb-2 last:mb-0', emphasis === 'target' && 'bg-muted/30')}>
      <div className="flex items-baseline justify-between">
        <Link href={`/stock/${row.ticker}`} className="font-mono font-medium text-lg hover:text-primary">
          {row.ticker}
        </Link>
        {row.similarity != null && (
          <span className="text-xs text-muted-foreground">
            {Math.round(row.similarity * 100)}% match
          </span>
        )}
      </div>
      <div className="text-sm text-muted-foreground mb-2">{row.name}</div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-muted-foreground">Market Cap</div>
          <PeerCell value={row.marketCap} allValues={marketCaps} direction="higher-is-better" format="currency" />
        </div>
        <div>
          <div className="text-muted-foreground">P/E</div>
          <PeerCell value={row.pe} allValues={pes} direction="lower-is-better" format="multiple" />
        </div>
        <div>
          <div className="text-muted-foreground">EV/EBITDA</div>
          <PeerCell value={row.evEbitda} allValues={evEbitdas} direction="lower-is-better" format="multiple" />
        </div>
        <div>
          <div className="text-muted-foreground">Rev Growth</div>
          <PeerCell value={row.revGrowthYoy} allValues={revGrowths} direction="higher-is-better" format="percent" />
        </div>
        <div>
          <div className="text-muted-foreground">Gross Margin</div>
          <PeerCell value={row.grossMargin} allValues={grossMargs} direction="higher-is-better" format="percent" />
        </div>
        <div>
          <div className="text-muted-foreground">ROE</div>
          <PeerCell value={row.roe} allValues={roes} direction="higher-is-better" format="percent" />
        </div>
        <div>
          <div className="text-muted-foreground">F-Score</div>
          <PeerCell value={row.fScore} allValues={fScores} direction="higher-is-better" format="integer" />
        </div>
      </div>
    </li>
  );
}
