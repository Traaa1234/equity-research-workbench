/** All multiples return null when inputs are missing or undefined. */

type Maybe = number | null | undefined;

function isFiniteNum(v: Maybe): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Price-to-Earnings. Returns null when EPS is non-positive (P/E is undefined for losses).
 */
export function computePE(price: Maybe, eps: Maybe): number | null {
  if (!isFiniteNum(price) || !isFiniteNum(eps)) return null;
  if (eps <= 0) return null;
  return price / eps;
}

/** Price-to-Sales. */
export function computePS(marketCap: Maybe, revenue: Maybe): number | null {
  if (!isFiniteNum(marketCap) || !isFiniteNum(revenue)) return null;
  if (revenue <= 0) return null;
  return marketCap / revenue;
}

/** Price-to-Book. Returns null for non-positive book value. */
export function computePB(marketCap: Maybe, bookValue: Maybe): number | null {
  if (!isFiniteNum(marketCap) || !isFiniteNum(bookValue)) return null;
  if (bookValue <= 0) return null;
  return marketCap / bookValue;
}

/** Enterprise Value to EBITDA. */
export function computeEVtoEBITDA(ev: Maybe, ebitda: Maybe): number | null {
  if (!isFiniteNum(ev) || !isFiniteNum(ebitda)) return null;
  if (ebitda <= 0) return null;
  return ev / ebitda;
}

/**
 * PEG ratio = P/E / earnings growth %.
 * `growthPct` is a percentage (e.g. 10 for 10% growth).
 */
export function computePEG(pe: Maybe, growthPct: Maybe): number | null {
  if (!isFiniteNum(pe) || !isFiniteNum(growthPct)) return null;
  if (growthPct <= 0) return null;
  return pe / growthPct;
}
