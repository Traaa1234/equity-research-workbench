import { describe, it, expect } from 'vitest';
import { percentile, orientedPercentile, changeOverMonths, pctReturnOverMonths, pctVsMA, scoreCountries } from '@/lib/compute/country-score';

const s = (vals: [string, number][]) => vals.map(([date, value]) => ({ date, value }));

describe('helpers', () => {
  it('percentile', () => {
    expect(percentile([1, 2, 3, 4], 4)).toBeCloseTo(100);
    expect(percentile([1, 2, 3, 4], 1)).toBeCloseTo(25);
    expect(percentile([], 5)).toBe(50);
  });
  it('orientedPercentile inverts for lower-is-better', () => {
    expect(orientedPercentile([1, 2, 3, 4], 1, 'lower')).toBeCloseTo(75);
    expect(orientedPercentile([1, 2, 3, 4], 4, 'lower')).toBeCloseTo(0);
  });
  it('changeOverMonths / pctReturnOverMonths', () => {
    const series = s([['2026-01-01', 100], ['2026-07-01', 112]]);
    expect(changeOverMonths(series, 6)).toBeCloseTo(12);
    expect(pctReturnOverMonths(series, 6)).toBeCloseTo(12);
  });
  it('pctVsMA', () => {
    const series = s(Array.from({ length: 250 }, (_, i) => [`2026-01-${String((i % 28) + 1).padStart(2, '0')}`, 100] as [string, number]));
    series[series.length - 1] = { date: '2026-09-01', value: 110 };
    expect(pctVsMA(series, 200)!).toBeGreaterThan(0);
  });
});

describe('scoreCountries', () => {
  const mk = (code: string, cli: number, etf6mo: number) => ({
    code, name: code, flag: '🏳️', series: {
      cli: s([['2026-01-01', cli - 2], ['2026-07-01', cli]]),
      unemployment: [], longRate: [], cpi: [],
      etf: s([['2026-01-01', 100], ['2026-07-01', 100 * (1 + etf6mo / 100)]]),
    },
  });
  it('ranks higher-growth + higher-momentum countries above', () => {
    const rows = scoreCountries([mk('AAA', 102, 20), mk('BBB', 98, -10), mk('CCC', 100, 5)]);
    expect(rows[0]!.code).toBe('AAA');
    expect(rows[rows.length - 1]!.code).toBe('BBB');
    expect(rows[0]!.rank).toBe(1);
  });
  it('missing dimension scores 50 (neutral), not 0', () => {
    const rows = scoreCountries([mk('AAA', 102, 20), mk('BBB', 98, -10)]);
    const aaa = rows.find((r) => r.code === 'AAA')!;
    expect(aaa.dims.inflation).toBe(50);
    expect(aaa.dims.rates).toBe(50);
  });
});
