type Maybe = number | null | undefined;

function isFiniteNum(v: Maybe): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Return on Equity. Null when equity is non-positive. */
export function computeROE(netIncome: Maybe, equity: Maybe): number | null {
  if (!isFiniteNum(netIncome) || !isFiniteNum(equity)) return null;
  if (equity <= 0) return null;
  return netIncome / equity;
}

/** Return on Assets. */
export function computeROA(netIncome: Maybe, totalAssets: Maybe): number | null {
  if (!isFiniteNum(netIncome) || !isFiniteNum(totalAssets)) return null;
  if (totalAssets <= 0) return null;
  return netIncome / totalAssets;
}

/**
 * Return on Invested Capital.
 * NOPAT = operatingIncome * (1 - taxRate); ROIC = NOPAT / investedCapital.
 * taxRate must be in [0, 1].
 */
export function computeROIC(
  operatingIncome: Maybe,
  taxRate: Maybe,
  investedCapital: Maybe
): number | null {
  if (!isFiniteNum(operatingIncome) || !isFiniteNum(taxRate) || !isFiniteNum(investedCapital))
    return null;
  if (taxRate < 0 || taxRate > 1) return null;
  if (investedCapital <= 0) return null;
  const nopat = operatingIncome * (1 - taxRate);
  return nopat / investedCapital;
}
