import { describe, it, expect } from 'vitest';
import { buildReturnsSeries } from '@/lib/compute/dashboard';
import type { FundamentalRow } from '@/lib/providers/types';

function row(periodEnd: string, lineItem: string, value: number): FundamentalRow {
  return { periodEnd, lineItem, value, currency: 'USD' };
}

describe('buildReturnsSeries', () => {
  it('computes ROE, ROA, and margins per year', () => {
    const income = [
      row('2024-09-30', 'revenue', 1000),
      row('2024-09-30', 'gross_profit', 400),
      row('2024-09-30', 'operating_income', 200),
      row('2024-09-30', 'net_income', 100),
      row('2023-09-30', 'revenue', 800),
      row('2023-09-30', 'gross_profit', 320),
      row('2023-09-30', 'operating_income', 160),
      row('2023-09-30', 'net_income', 80)
    ];
    const balance = [
      row('2024-09-30', 'total_assets', 2000),
      row('2024-09-30', 'total_equity', 500),
      row('2023-09-30', 'total_assets', 1800),
      row('2023-09-30', 'total_equity', 400)
    ];

    const out = buildReturnsSeries(income, balance);

    expect(out).toHaveLength(2);
    expect(out[0]!.periodEnd).toBe('2024-09-30');
    expect(out[0]!.roe).toBeCloseTo(0.2);
    expect(out[0]!.roa).toBeCloseTo(0.05);
    expect(out[0]!.grossMargin).toBeCloseTo(0.4);
    expect(out[0]!.operatingMargin).toBeCloseTo(0.2);
    expect(out[0]!.netMargin).toBeCloseTo(0.1);
  });

  it('returns null for any metric whose inputs are missing', () => {
    const income = [row('2024-09-30', 'revenue', 1000)];
    const out = buildReturnsSeries(income, []);
    expect(out[0]!.roe).toBeNull();
    expect(out[0]!.roa).toBeNull();
    expect(out[0]!.grossMargin).toBeNull();
  });
});
