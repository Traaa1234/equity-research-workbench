import { describe, it, expect } from 'vitest';
import { periodReturn, relativeReturn, sectorReturns, WINDOWS } from '@/lib/compute/sector-analytics';

const pts = (vals: number[]) =>
  vals.map((value, i) => ({ date: `2026-${String(i + 1).padStart(2, '0')}-01`, value }));

describe('periodReturn', () => {
  it('computes (last / prev) - 1 for offset 1', () => {
    // prices[2]=105, prices[1]=102 → (105/102)-1
    expect(periodReturn(pts([100, 102, 105]), 1)).toBeCloseTo((105 / 102) - 1);
  });
  it('computes larger offsets correctly', () => {
    // prices[4]=110, prices[0]=100 → (110/100)-1 = 0.1
    expect(periodReturn(pts([100, 102, 104, 106, 110]), 4)).toBeCloseTo(0.1);
  });
  it('returns null when array length <= windowOffset', () => {
    expect(periodReturn(pts([100, 101]), 2)).toBeNull();
    expect(periodReturn(pts([100]), 1)).toBeNull();
    expect(periodReturn([], 1)).toBeNull();
  });
  it('returns null when reference price is 0', () => {
    expect(periodReturn(pts([0, 100]), 1)).toBeNull();
  });
});

describe('relativeReturn', () => {
  it('subtracts benchmarkRet from sectorRet', () => {
    expect(relativeReturn(0.05, 0.03)).toBeCloseTo(0.02);
    expect(relativeReturn(-0.02, 0.01)).toBeCloseTo(-0.03);
  });
  it('returns null when sectorRet is null', () => {
    expect(relativeReturn(null, 0.03)).toBeNull();
  });
  it('returns null when benchmarkRet is null', () => {
    expect(relativeReturn(0.05, null)).toBeNull();
  });
  it('returns null when both are null', () => {
    expect(relativeReturn(null, null)).toBeNull();
  });
});

describe('sectorReturns', () => {
  it('computes returns for all symbols over all windows', () => {
    // 3 prices → can compute 1D (offset 1) and 2D (offset 2)
    const prices = pts([100, 102, 105]);
    const result = sectorReturns({ XLK: prices, XLF: prices }, { '1D': 1, '2D': 2 });
    expect(result['XLK']).toBeDefined();
    expect(result['XLK']!['1D']).toBeCloseTo((105 / 102) - 1);
    expect(result['XLK']!['2D']).toBeCloseTo((105 / 100) - 1);
    expect(result['XLF']!['1D']).toBeCloseTo((105 / 102) - 1);
  });
  it('returns null for windows wider than available data', () => {
    const result = sectorReturns({ XLK: pts([100, 101]) }, { '1Y': 252 });
    expect(result['XLK']!['1Y']).toBeNull();
  });
  it('handles empty price array gracefully', () => {
    const result = sectorReturns({ XLK: [] }, WINDOWS);
    expect(Object.values(result['XLK']!).every((v) => v === null)).toBe(true);
  });
});
