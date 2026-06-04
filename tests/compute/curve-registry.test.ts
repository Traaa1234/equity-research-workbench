import { describe, it, expect } from 'vitest';
import { CURVE_MATURITIES, CURVE_SPREADS, curveSeriesIds } from '@/lib/compute/curve-registry';

describe('curve registry', () => {
  it('has 9 maturities ordered by months ascending', () => {
    expect(CURVE_MATURITIES).toHaveLength(9);
    const months = CURVE_MATURITIES.map((m) => m.months);
    expect([...months].sort((a, b) => a - b)).toEqual(months);
  });
  it('has 3 spreads whose long/short ids are real maturities', () => {
    expect(CURVE_SPREADS).toHaveLength(3);
    const ids = new Set(curveSeriesIds());
    for (const sp of CURVE_SPREADS) { expect(ids.has(sp.long)).toBe(true); expect(ids.has(sp.short)).toBe(true); }
  });
  it('curveSeriesIds returns 9 unique ids', () => {
    expect(new Set(curveSeriesIds()).size).toBe(9);
  });
});
