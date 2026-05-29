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

  const allAttempts: Array<{ level: FallbackLevel; filters: FilterSet }> = [
    { level: 'strict',     filters: { country: filters.country, sizeBand: filters.sizeBand } },
    { level: 'no_country', filters: { country: null,            sizeBand: filters.sizeBand } },
    { level: 'no_size',    filters: { country: filters.country, sizeBand: null            } },
    { level: 'global',     filters: { country: null,            sizeBand: null            } }
  ];

  // Dedup: when the target has null country, `strict` and `no_country` produce
  // identical FilterSets (same for `no_size` and `global` when sizeBand is null,
  // and all four when both are null). Drop later duplicates so we don't fire
  // redundant queries and don't mislabel the result.
  const seen = new Set<string>();
  const attempts = allAttempts.filter((a) => {
    const key = `${a.filters.country ?? ''}|${a.filters.sizeBand ? `${a.filters.sizeBand.min}-${a.filters.sizeBand.max}` : ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let last: FallbackResult = { level: attempts[0]!.level, tickers: [] };
  for (const attempt of attempts) {
    let tickers: string[];
    try {
      tickers = await tryQuery(attempt.filters);
    } catch (err) {
      throw new Error(`selectFallback: tryQuery failed at level "${attempt.level}"`, { cause: err });
    }
    last = { level: attempt.level, tickers };
    if (tickers.length >= k) return last;
  }
  return last;   // best-effort: return last attempt even if < K
}
