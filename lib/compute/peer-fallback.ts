/**
 * Peer-candidate fallback chain.
 *
 * Given a target's hard filters (country, size band), try the strict query
 * first. If it returns fewer than K rows, progressively relax filters until
 * we hit K or run out of relaxation steps.
 *
 * The actual SQL is injected via `tryQuery` to keep this module pure-
 * functional and testable without a DB.
 */

export type FallbackLevel = 'strict' | 'no_country' | 'no_size' | 'global';

export interface FilterSet {
  country: string | null;                                         // null = no country filter
  sizeBand: { min: number; max: number } | null;                  // null = no size filter
}

export interface FallbackResult {
  level: FallbackLevel;
  tickers: string[];
}

export interface SelectFallbackInput {
  k: number;
  filters: FilterSet;                                             // strict filters from target
  tryQuery: (filters: FilterSet) => Promise<string[]>;            // injected SQL runner
}

export async function selectFallback(input: SelectFallbackInput): Promise<FallbackResult> {
  const { k, filters, tryQuery } = input;

  const attempts: Array<{ level: FallbackLevel; filters: FilterSet }> = [
    { level: 'strict',     filters: { country: filters.country, sizeBand: filters.sizeBand } },
    { level: 'no_country', filters: { country: null,            sizeBand: filters.sizeBand } },
    { level: 'no_size',    filters: { country: filters.country, sizeBand: null            } },
    { level: 'global',     filters: { country: null,            sizeBand: null            } }
  ];

  let last: FallbackResult = { level: 'global', tickers: [] };
  for (const attempt of attempts) {
    const tickers = await tryQuery(attempt.filters);
    last = { level: attempt.level, tickers };
    if (tickers.length >= k) return last;
  }
  return last;   // best-effort: return last attempt even if < K
}
