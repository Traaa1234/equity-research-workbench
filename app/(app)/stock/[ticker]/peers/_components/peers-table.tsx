import type { PeersResult, PeerFallback } from '@/lib/services/peers';
import { PeerRow } from './peer-row';
import { PeerRowMobile } from './peer-row-mobile';

interface Props {
  result: PeersResult;
}

function fallbackNote(result: PeersResult): string {
  const country = result.target.country;
  const k = result.peers.length;
  const fb: PeerFallback = result.fallback;

  // No peers found at all — clearer copy than "0 peers semantically similar to…"
  if (k === 0 && fb !== 'target_missing') {
    return `No comparable peers found for ${result.target.ticker} at any fallback level.`;
  }

  switch (fb) {
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
    default: {
      // Exhaustiveness — compile-time error if PeerFallback gains a new variant
      const _exhaustive: never = fb;
      return String(_exhaustive);
    }
  }
}

export function PeersTable({ result }: Props) {
  // Defensive: the page should route target_missing to <PeersEmpty>. If a
  // future caller passes it here anyway, render nothing rather than a header
  // with an all-null row underneath.
  if (result.fallback === 'target_missing') return null;

  const allRows = [result.target, ...result.peers];

  return (
    <div className="space-y-4">
      <div className="hidden sm:block rounded border border-border overflow-hidden">
        <div role="row" className="grid grid-cols-12 gap-3 px-3 py-2 bg-muted text-xs font-medium uppercase tracking-wide text-muted-foreground">
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
        </div>
        <ul aria-label="Peer companies">
          <PeerRow row={result.target} allRows={allRows} emphasis="target" />
          {result.peers.map((p) => (
            <PeerRow key={p.ticker} row={p} allRows={allRows} emphasis="peer" />
          ))}
        </ul>
      </div>

      <ul className="sm:hidden" aria-label="Peer companies">
        <PeerRowMobile row={result.target} allRows={allRows} emphasis="target" />
        {result.peers.map((p) => (
          <PeerRowMobile key={p.ticker} row={p} allRows={allRows} emphasis="peer" />
        ))}
      </ul>

      <p className="text-xs text-muted-foreground">{fallbackNote(result)}</p>
    </div>
  );
}
