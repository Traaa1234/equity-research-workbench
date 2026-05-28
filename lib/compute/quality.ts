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
