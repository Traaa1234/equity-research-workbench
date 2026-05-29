import type { PeersResult } from '@/lib/services/peers';
import { PeerRow } from './peer-row';
import { PeerRowMobile } from './peer-row-mobile';

interface Props {
  result: PeersResult;
}

function fallbackNote(result: PeersResult): string {
  const country = result.target.country;
  const k = result.peers.length;
  switch (result.fallback) {
    case 'strict':
      return `${k} peers semantically similar to ${result.target.ticker}, market cap 0.3x–3x${country ? `, ${country}-listed` : ''}.`;
    case 'no_country':
      return `${k} peers semantically similar to ${result.target.ticker}, market cap 0.3x–3x. Not enough same-country matches; showing global peers within size band.`;
    case 'no_size':
      return `${k} peers semantically similar to ${result.target.ticker}${country ? `, ${country}-listed` : ''}. Not enough same-size matches; showing same-country peers regardless of market cap.`;
    case 'global':
      return `${k} peers semantically similar to ${result.target.ticker} (global). Not enough same-country, same-size matches.`;
    case 'target_missing':
      return `No description data for ${result.target.ticker} yet. Try refreshing the universe or wait for tomorrow's sync.`;
  }
}

export function PeersTable({ result }: Props) {
  const allRows = [result.target, ...result.peers];

  return (
    <div className="space-y-4">
      <div className="hidden sm:block rounded border border-border overflow-hidden">
        <header className="grid grid-cols-12 gap-3 px-3 py-2 bg-muted text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <div className="col-span-2">Ticker</div>
          <div className="col-span-2">Name</div>
          <div className="col-span-1">Country</div>
          <div className="col-span-1 text-right">Mkt Cap</div>
          <div className="col-span-1 text-right">P/E</div>
          <div className="col-span-1 text-right">EV/EBITDA</div>
          <div className="col-span-1 text-right">Rev YoY</div>
          <div className="col-span-1 text-right">Gross %</div>
          <div className="col-span-1 text-right">ROE</div>
          <div className="col-span-1 text-right">F-Score</div>
        </header>
        <ul>
          <PeerRow row={result.target} allRows={allRows} emphasis="target" />
          {result.peers.map((p) => (
            <PeerRow key={p.ticker} row={p} allRows={allRows} emphasis="peer" />
          ))}
        </ul>
      </div>

      <ul className="sm:hidden">
        <PeerRowMobile row={result.target} allRows={allRows} emphasis="target" />
        {result.peers.map((p) => (
          <PeerRowMobile key={p.ticker} row={p} allRows={allRows} emphasis="peer" />
        ))}
      </ul>

      <p className="text-xs text-muted-foreground">{fallbackNote(result)}</p>
    </div>
  );
}
