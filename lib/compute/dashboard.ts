import type { FundamentalRow } from '@/lib/providers/types';
import { computeROE, computeROA } from '@/lib/compute/returns';

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
