import type { FundamentalRow } from '@/lib/providers/types';
import { computeROE, computeROA } from '@/lib/compute/returns';
import { computeCAGR } from '@/lib/compute/growth';

export interface ReturnsPoint {
  periodEnd: string;
  roe: number | null;
  roa: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
}

function findValue(rows: FundamentalRow[], periodEnd: string, lineItem: string): number | null {
  return rows.find((r) => r.periodEnd === periodEnd && r.lineItem === lineItem)?.value ?? null;
}

export function buildReturnsSeries(
  income: FundamentalRow[],
  balance: FundamentalRow[]
): ReturnsPoint[] {
  const periods = Array.from(
    new Set([...income.map((r) => r.periodEnd), ...balance.map((r) => r.periodEnd)])
  )
    .sort()
    .reverse()
    .slice(0, 5);

  return periods.map((periodEnd) => {
    const revenue = findValue(income, periodEnd, 'revenue');
    const grossProfit = findValue(income, periodEnd, 'gross_profit');
    const operatingIncome = findValue(income, periodEnd, 'operating_income');
    const netIncome = findValue(income, periodEnd, 'net_income');
    const totalEquity = findValue(balance, periodEnd, 'total_equity');
    const totalAssets = findValue(balance, periodEnd, 'total_assets');

    return {
      periodEnd,
      roe: computeROE(netIncome, totalEquity),
      roa: computeROA(netIncome, totalAssets),
      grossMargin: revenue && grossProfit != null ? grossProfit / revenue : null,
      operatingMargin: revenue && operatingIncome != null ? operatingIncome / revenue : null,
      netMargin: revenue && netIncome != null ? netIncome / revenue : null
    };
  });
}

export interface GrowthSummary {
  revenueCAGR3Y: number | null;
  revenueCAGR5Y: number | null;
  epsCAGR3Y: number | null;
  epsCAGR5Y: number | null;
  fcfCAGR3Y: number | null;
  fcfCAGR5Y: number | null;
}

/**
 * Find the value approximately `years` years prior to the most recent entry
 * for the given line item. Tolerates ±9 months of slack so that fiscal-year
 * boundaries that don't line up perfectly still match.
 */
function valueYearsAgo(
  rows: FundamentalRow[],
  lineItem: string,
  years: number
): number | null {
  const filtered = rows
    .filter((r) => r.lineItem === lineItem && r.value != null)
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  if (filtered.length === 0) return null;
  const mostRecent = filtered[0]!;
  const recentMs = Date.parse(mostRecent.periodEnd);
  if (isNaN(recentMs)) return null;
  const targetMs = recentMs - years * 365.25 * 24 * 60 * 60 * 1000;
  const toleranceMs = 9 * 30 * 24 * 60 * 60 * 1000;
  let best: FundamentalRow | null = null;
  let bestDelta = Infinity;
  for (const r of filtered) {
    const delta = Math.abs(Date.parse(r.periodEnd) - targetMs);
    if (delta < bestDelta) {
      best = r;
      bestDelta = delta;
    }
  }
  return best && bestDelta <= toleranceMs ? (best.value ?? null) : null;
}

function mostRecent(rows: FundamentalRow[], lineItem: string): number | null {
  const sorted = rows
    .filter((r) => r.lineItem === lineItem && r.value != null)
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  return sorted[0]?.value ?? null;
}

export function buildGrowthSummary(
  income: FundamentalRow[],
  cashFlow: FundamentalRow[]
): GrowthSummary {
  const cagr = (end: number | null, start: number | null, years: number) =>
    computeCAGR(end, start, years);

  return {
    revenueCAGR3Y: cagr(
      mostRecent(income, 'revenue'),
      valueYearsAgo(income, 'revenue', 3),
      3
    ),
    revenueCAGR5Y: cagr(
      mostRecent(income, 'revenue'),
      valueYearsAgo(income, 'revenue', 5),
      5
    ),
    epsCAGR3Y: cagr(
      mostRecent(income, 'earnings_per_share'),
      valueYearsAgo(income, 'earnings_per_share', 3),
      3
    ),
    epsCAGR5Y: cagr(
      mostRecent(income, 'earnings_per_share'),
      valueYearsAgo(income, 'earnings_per_share', 5),
      5
    ),
    fcfCAGR3Y: cagr(
      mostRecent(cashFlow, 'free_cash_flow'),
      valueYearsAgo(cashFlow, 'free_cash_flow', 3),
      3
    ),
    fcfCAGR5Y: cagr(
      mostRecent(cashFlow, 'free_cash_flow'),
      valueYearsAgo(cashFlow, 'free_cash_flow', 5),
      5
    )
  };
}
