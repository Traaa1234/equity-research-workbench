/**
 * Quality screens — pure-functional compute for Piotroski F-Score,
 * Altman Z-Score, and Beneish M-Score over annual financial statements.
 *
 * All functions return `null` when required inputs are missing rather than
 * throwing or producing NaN. Callers (UI) render "—" for null.
 *
 * Sources:
 *   Piotroski, J. (2000), "Value Investing: The Use of Historical Financial
 *     Statement Information to Separate Winners from Losers," J. Accounting
 *     Research.
 *   Altman, E. (1968), "Financial Ratios, Discriminant Analysis and the
 *     Prediction of Corporate Bankruptcy," Journal of Finance.
 *   Beneish, M. (1999), "The Detection of Earnings Manipulation,"
 *     Financial Analysts Journal.
 */

export interface AnnualFinancials {
  periodEnd: string;             // ISO YYYY-MM-DD
  // Income statement
  revenue: number | null;
  costOfRevenue: number | null;
  grossProfit: number | null;
  sga: number | null;
  depreciation: number | null;
  ebit: number | null;
  netIncome: number | null;
  // Balance sheet
  cashAndEquivalents: number | null;
  receivables: number | null;
  currentAssets: number | null;
  ppe: number | null;
  totalAssets: number | null;
  currentLiabilities: number | null;
  longTermDebt: number | null;
  totalLiabilities: number | null;
  retainedEarnings: number | null;
  sharesOutstanding: number | null;
  // Cash flow statement
  operatingCashFlow: number | null;
}

export interface PiotroskiResult {
  score: number;                                              // 0-9
  tests: Array<{ name: string; passed: boolean }>;
}

function isFiniteNum(v: number | null): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Piotroski F-Score: nine binary tests of fundamental strength.
 * Each "passed" test contributes 1 point. Score 7-9 = healthy,
 * 4-6 = mediocre, 0-3 = weak.
 *
 * Returns null when any required input is missing.
 */
export function piotroskiFScore(
  current: AnnualFinancials,
  prior: AnnualFinancials
): PiotroskiResult | null {
  // All 9 tests reference these inputs at minimum:
  const required = [
    current.netIncome, current.operatingCashFlow, current.totalAssets,
    current.longTermDebt, current.currentAssets, current.currentLiabilities,
    current.sharesOutstanding, current.grossProfit, current.revenue,
    prior.netIncome, prior.totalAssets, prior.longTermDebt,
    prior.currentAssets, prior.currentLiabilities, prior.sharesOutstanding,
    prior.grossProfit, prior.revenue
  ];
  if (!required.every(isFiniteNum)) return null;

  const currentROA = current.netIncome! / current.totalAssets!;
  const priorROA   = prior.netIncome!   / prior.totalAssets!;
  const currentLeverage = current.longTermDebt! / current.totalAssets!;
  const priorLeverage   = prior.longTermDebt!   / prior.totalAssets!;
  const currentRatio    = current.currentAssets! / current.currentLiabilities!;
  const priorRatio      = prior.currentAssets!   / prior.currentLiabilities!;
  const currentGM   = current.grossProfit! / current.revenue!;
  const priorGM     = prior.grossProfit!   / prior.revenue!;
  const currentAT   = current.revenue!  / current.totalAssets!;
  const priorAT     = prior.revenue!    / prior.totalAssets!;

  const tests = [
    { name: 'Positive net income',                                passed: current.netIncome! > 0 },
    { name: 'Positive operating cash flow',                       passed: current.operatingCashFlow! > 0 },
    { name: 'Higher ROA YoY',                                     passed: currentROA > priorROA },
    { name: 'Operating CF > net income (high quality earnings)',  passed: current.operatingCashFlow! > current.netIncome! },
    { name: 'Lower leverage YoY',                                 passed: currentLeverage < priorLeverage },
    { name: 'Higher current ratio YoY',                           passed: currentRatio > priorRatio },
    { name: 'No share dilution',                                  passed: current.sharesOutstanding! <= prior.sharesOutstanding! },
    { name: 'Higher gross margin YoY',                            passed: currentGM > priorGM },
    { name: 'Higher asset turnover YoY',                          passed: currentAT > priorAT }
  ];
  const score = tests.filter((t) => t.passed).length;
  return { score, tests };
}

export type AltmanZone = 'safe' | 'caution' | 'distress';

export interface AltmanResult {
  score: number;
  zone: AltmanZone;
  components: { a: number; b: number; c: number; d: number; e: number };
}

/**
 * Altman Z-Score (1968 model for public manufacturers).
 *
 *   Z = 1.2·A + 1.4·B + 3.3·C + 0.6·D + 1.0·E
 *
 *   A = Working capital / Total assets
 *   B = Retained earnings / Total assets
 *   C = EBIT / Total assets
 *   D = Market value of equity / Total liabilities
 *   E = Sales / Total assets
 *
 * Zones: Z > 2.99 safe, 1.81 < Z < 2.99 caution, Z < 1.81 distress.
 * Best-suited for non-financial manufacturers — UI footnote warns.
 *
 * Returns null when any required input is missing.
 */
export function altmanZScore(
  f: AnnualFinancials,
  marketCap: number
): AltmanResult | null {
  if (
    !isFiniteNum(f.currentAssets) ||
    !isFiniteNum(f.currentLiabilities) ||
    !isFiniteNum(f.totalAssets) ||
    !isFiniteNum(f.retainedEarnings) ||
    !isFiniteNum(f.ebit) ||
    !isFiniteNum(f.totalLiabilities) ||
    !isFiniteNum(f.revenue) ||
    !isFiniteNum(marketCap) ||
    f.totalAssets === 0 ||
    f.totalLiabilities === 0
  ) {
    return null;
  }

  const workingCapital = f.currentAssets - f.currentLiabilities;
  const a = workingCapital / f.totalAssets;
  const b = f.retainedEarnings / f.totalAssets;
  const c = f.ebit / f.totalAssets;
  const d = marketCap / f.totalLiabilities;
  const e = f.revenue / f.totalAssets;

  const score = 1.2 * a + 1.4 * b + 3.3 * c + 0.6 * d + 1.0 * e;
  const zone: AltmanZone =
    score > 2.99 ? 'safe' : score < 1.81 ? 'distress' : 'caution';

  return { score, zone, components: { a, b, c, d, e } };
}

export interface BeneishResult {
  score: number;
  flag: boolean;        // true if score > -1.78 (manipulation possible)
  components: {
    dsri: number; gmi: number; aqi: number; sgi: number;
    depi: number; sgai: number; lvgi: number; tata: number;
  };
}

/**
 * Beneish M-Score: 8-variable model detecting earnings manipulation.
 *
 *   M = -4.84 + 0.920·DSRI + 0.528·GMI + 0.404·AQI + 0.892·SGI
 *           + 0.115·DEPI − 0.172·SGAI + 4.679·TATA − 0.327·LVGI
 *
 * Threshold: M > -1.78 → manipulation possible (suspicion signal, not proof).
 *
 * Each variable is a YoY ratio. GMI and DEPI are inverted (prior/current
 * rather than current/prior) by Beneish's convention.
 *
 * Returns null when any required input is missing.
 */
export function beneishMScore(
  current: AnnualFinancials,
  prior: AnnualFinancials
): BeneishResult | null {
  const req = [
    current.revenue, current.costOfRevenue, current.grossProfit,
    current.sga, current.depreciation, current.netIncome,
    current.operatingCashFlow, current.receivables, current.currentAssets,
    current.ppe, current.totalAssets, current.totalLiabilities,
    prior.revenue, prior.costOfRevenue, prior.grossProfit,
    prior.sga, prior.depreciation, prior.receivables, prior.currentAssets,
    prior.ppe, prior.totalAssets, prior.totalLiabilities
  ];
  if (!req.every(isFiniteNum)) return null;

  // Guard against div-by-zero across the formula
  if (
    current.revenue === 0 || prior.revenue === 0 ||
    current.totalAssets === 0 || prior.totalAssets === 0 ||
    current.ppe! + current.depreciation! === 0 ||
    prior.ppe! + prior.depreciation! === 0
  ) {
    return null;
  }

  // DSRI: Days Sales in Receivables Index
  const dsri = (current.receivables! / current.revenue!) /
               (prior.receivables!   / prior.revenue!);

  // GMI: Gross Margin Index (inverted — prior / current)
  const currentGM = current.grossProfit! / current.revenue!;
  const priorGM   = prior.grossProfit!   / prior.revenue!;
  const gmi = priorGM / currentGM;

  // AQI: Asset Quality Index
  const currentSoftRatio = 1 - (current.currentAssets! + current.ppe!) / current.totalAssets!;
  const priorSoftRatio   = 1 - (prior.currentAssets!   + prior.ppe!)   / prior.totalAssets!;
  const aqi = currentSoftRatio / priorSoftRatio;

  // SGI: Sales Growth Index
  const sgi = current.revenue! / prior.revenue!;

  // DEPI: Depreciation Index (inverted — prior rate / current rate)
  const currentDeprRate = current.depreciation! / (current.ppe! + current.depreciation!);
  const priorDeprRate   = prior.depreciation!   / (prior.ppe!   + prior.depreciation!);
  const depi = priorDeprRate / currentDeprRate;

  // SGAI: SGA Index
  const sgai = (current.sga! / current.revenue!) / (prior.sga! / prior.revenue!);

  // LVGI: Leverage Index
  const lvgi = (current.totalLiabilities! / current.totalAssets!) /
               (prior.totalLiabilities!   / prior.totalAssets!);

  // TATA: Total Accruals to Total Assets (current year only)
  const tata = (current.netIncome! - current.operatingCashFlow!) / current.totalAssets!;

  const score = -4.84
    + 0.920 * dsri
    + 0.528 * gmi
    + 0.404 * aqi
    + 0.892 * sgi
    + 0.115 * depi
    - 0.172 * sgai
    + 4.679 * tata
    - 0.327 * lvgi;

  return {
    score,
    flag: score > -1.78,
    components: { dsri, gmi, aqi, sgi, depi, sgai, lvgi, tata }
  };
}
