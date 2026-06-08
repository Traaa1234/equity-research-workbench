export interface PricePoint {
  date: string;
  value: number;
}

export type ReturnWindow = '1D' | '1W' | '1M' | '3M' | '1Y';

/** Trading-day offsets for each return window. */
export const WINDOWS: Record<ReturnWindow, number> = {
  '1D': 1,
  '1W': 5,
  '1M': 21,
  '3M': 63,
  '1Y': 252,
};

/**
 * Return (prices[last] / prices[last - windowOffset]) - 1.
 * Uses trading-day offset (array index), NOT calendar-date arithmetic.
 * Assumes prices is sorted ascending by date — unsorted input silently produces wrong results.
 * Returns null when prices.length <= windowOffset or reference price is 0.
 */
export function periodReturn(prices: PricePoint[], windowOffset: number): number | null {
  if (prices.length <= windowOffset) return null;
  const last = prices[prices.length - 1]!.value;
  const prev = prices[prices.length - 1 - windowOffset]!.value;
  if (prev === 0) return null;
  return (last / prev) - 1;
}

/**
 * Excess return: sectorRet - benchmarkRet.
 * Returns null if either input is null.
 */
export function relativeReturn(
  sectorRet: number | null,
  benchmarkRet: number | null,
): number | null {
  if (sectorRet == null || benchmarkRet == null) return null;
  return sectorRet - benchmarkRet;
}

/**
 * Compute returns for every symbol over every window.
 * windows is a map of label → trading-day offset, e.g. { '1D': 1, '1W': 5, ... }.
 * Each symbol's returns are computed independently from its own price array.
 */
export function sectorReturns(
  allPrices: Record<string, PricePoint[]>,
  windows: Record<string, number>,
): Record<string, Record<string, number | null>> {
  const result: Record<string, Record<string, number | null>> = {};
  for (const [sym, prices] of Object.entries(allPrices)) {
    result[sym] = {};
    for (const [label, offset] of Object.entries(windows)) {
      result[sym]![label] = periodReturn(prices, offset);
    }
  }
  return result;
}
