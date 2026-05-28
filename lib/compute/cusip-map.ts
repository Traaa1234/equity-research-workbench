/**
 * CUSIP-to-ticker mapping for our watchlist.
 *
 * 13F filings use CUSIP (9-character security identifier), not ticker
 * symbols. CUSIPs verified against SEC EDGAR issuer pages.
 *
 * To add a watchlist ticker: look up its CUSIP at
 *   https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<ticker>
 * (the CUSIP appears in the company's filings header) and add one line
 * to CUSIP_BY_TICKER below.
 */

export const CUSIP_BY_TICKER: Readonly<Record<string, string>> = {
  AAPL:  '037833100',
  NVDA:  '67066G104',
  MSFT:  '594918104',
  GOOGL: '02079K305',     // Class A; GOOG is 02079K107 — Class A only in watchlist
  TSLA:  '88160R101',
  JD:    '47215P106'
};

const TICKER_BY_CUSIP: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CUSIP_BY_TICKER).map(([t, c]) => [c.toUpperCase(), t])
);

/**
 * Look up the watchlist ticker for a CUSIP. Returns null if the CUSIP
 * is not on the watchlist (e.g. a fund's other positions).
 */
export function tickerForCusip(cusip: string): string | null {
  return TICKER_BY_CUSIP[cusip.toUpperCase()] ?? null;
}

/**
 * All CUSIPs on the current watchlist. Used to filter incoming 13F
 * position rows before insert.
 */
export function watchlistCusips(): string[] {
  return Object.values(CUSIP_BY_TICKER);
}
