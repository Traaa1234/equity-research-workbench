import { describe, it, expect } from 'vitest';
import {
  piotroskiFScore,
  type AnnualFinancials
} from '@/lib/compute/quality';

function emptyFinancials(periodEnd: string): AnnualFinancials {
  return {
    periodEnd,
    revenue: null, costOfRevenue: null, grossProfit: null, sga: null,
    depreciation: null, ebit: null, netIncome: null,
    cashAndEquivalents: null, receivables: null, currentAssets: null,
    ppe: null, totalAssets: null, currentLiabilities: null,
    longTermDebt: null, totalLiabilities: null, retainedEarnings: null,
    sharesOutstanding: null, operatingCashFlow: null
  };
}

describe('piotroskiFScore', () => {
  it('returns 9/9 when all conditions improve', () => {
    const prior: AnnualFinancials = {
      ...emptyFinancials('2024-09-28'),
      netIncome: 50, operatingCashFlow: 60, totalAssets: 1000,
      longTermDebt: 200, currentAssets: 300, currentLiabilities: 250,
      sharesOutstanding: 100, grossProfit: 200, revenue: 800
    };
    const current: AnnualFinancials = {
      ...emptyFinancials('2025-09-27'),
      netIncome: 80, operatingCashFlow: 100, totalAssets: 1100,
      longTermDebt: 150, currentAssets: 400, currentLiabilities: 250,
      sharesOutstanding: 100, grossProfit: 280, revenue: 1000
    };

    const r = piotroskiFScore(current, prior);
    expect(r).not.toBeNull();
    expect(r!.score).toBe(9);
    expect(r!.tests.every((t) => t.passed)).toBe(true);
  });

  it('returns 0/9 when all conditions deteriorate', () => {
    const prior: AnnualFinancials = {
      ...emptyFinancials('2024-09-28'),
      netIncome: 100, operatingCashFlow: 120, totalAssets: 1000,
      longTermDebt: 100, currentAssets: 400, currentLiabilities: 200,
      sharesOutstanding: 100, grossProfit: 300, revenue: 1000
    };
    const current: AnnualFinancials = {
      ...emptyFinancials('2025-09-27'),
      netIncome: -10, operatingCashFlow: -20, totalAssets: 1200,
      longTermDebt: 300, currentAssets: 200, currentLiabilities: 400,
      sharesOutstanding: 120, grossProfit: 150, revenue: 800
    };

    const r = piotroskiFScore(current, prior);
    expect(r).not.toBeNull();
    expect(r!.score).toBe(0);
    expect(r!.tests.every((t) => !t.passed)).toBe(true);
  });

  it('returns null when required inputs are missing', () => {
    const prior = emptyFinancials('2024-09-28');
    const current = emptyFinancials('2025-09-27');
    const r = piotroskiFScore(current, prior);
    expect(r).toBeNull();
  });

  it('emits the 9 test names in canonical order', () => {
    const prior: AnnualFinancials = {
      ...emptyFinancials('2024-09-28'),
      netIncome: 50, operatingCashFlow: 60, totalAssets: 1000,
      longTermDebt: 200, currentAssets: 300, currentLiabilities: 250,
      sharesOutstanding: 100, grossProfit: 200, revenue: 800
    };
    const current: AnnualFinancials = {
      ...emptyFinancials('2025-09-27'),
      netIncome: 80, operatingCashFlow: 100, totalAssets: 1100,
      longTermDebt: 150, currentAssets: 400, currentLiabilities: 250,
      sharesOutstanding: 100, grossProfit: 280, revenue: 1000
    };
    const r = piotroskiFScore(current, prior)!;
    expect(r.tests.map((t) => t.name)).toEqual([
      'Positive net income',
      'Positive operating cash flow',
      'Higher ROA YoY',
      'Operating CF > net income (high quality earnings)',
      'Lower leverage YoY',
      'Higher current ratio YoY',
      'No share dilution',
      'Higher gross margin YoY',
      'Higher asset turnover YoY'
    ]);
  });
});
