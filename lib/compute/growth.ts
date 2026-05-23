type Maybe = number | null | undefined;

function isFiniteNum(v: Maybe): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Year-over-year growth as a decimal (0.10 = +10%).
 * Returns null when prior is non-positive — sign-flipping growth is misleading.
 */
export function computeYoY(current: Maybe, prior: Maybe): number | null {
  if (!isFiniteNum(current) || !isFiniteNum(prior)) return null;
  if (prior <= 0) return null;
  return (current - prior) / prior;
}

/**
 * Compound Annual Growth Rate as a decimal.
 *
 * @param end   ending value
 * @param start starting value
 * @param years number of years between start and end
 */
export function computeCAGR(end: Maybe, start: Maybe, years: Maybe): number | null {
  if (!isFiniteNum(end) || !isFiniteNum(start) || !isFiniteNum(years)) return null;
  if (start <= 0 || years <= 0) return null;
  return Math.pow(end / start, 1 / years) - 1;
}
