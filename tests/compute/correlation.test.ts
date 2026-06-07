import { describe, it, expect } from 'vitest';
import { dailyChange, alignByDate, pearson, correlationMatrix } from '@/lib/compute/correlation';

const s = (vals: [string, number][]) => vals.map(([date, value]) => ({ date, value }));

describe('dailyChange', () => {
  it('return = simple daily return for prices', () => {
    const r = dailyChange(s([['d1', 100], ['d2', 110]]), 'return');
    expect(r).toHaveLength(1);
    expect(r[0]!.date).toBe('d2');
    expect(r[0]!.value).toBeCloseTo(0.1);
  });
  it('diff = first difference for levels', () => {
    expect(dailyChange(s([['d1', 4.0], ['d2', 4.2]]), 'diff')[0]!.value).toBeCloseTo(0.2);
  });
  it('empty / single-point series → []', () => {
    expect(dailyChange([], 'return')).toEqual([]);
    expect(dailyChange(s([['d1', 1]]), 'diff')).toEqual([]);
  });
});

describe('alignByDate', () => {
  it('keeps only dates present in every series, sorted', () => {
    const a = s([['d1', 1], ['d2', 2], ['d3', 3]]);
    const b = s([['d2', 9], ['d3', 8], ['d4', 7]]);
    const { dates, values } = alignByDate([a, b]);
    expect(dates).toEqual(['d2', 'd3']);
    expect(values).toEqual([[2, 3], [9, 8]]);
  });
});

describe('pearson', () => {
  const lin = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
  it('+1 for identical', () => { const x = lin(12, (i) => i); expect(pearson(x, x)!).toBeCloseTo(1); });
  it('-1 for negated', () => { const x = lin(12, (i) => i); expect(pearson(x, x.map((v) => -v))!).toBeCloseTo(-1); });
  it('null when < 10 observations', () => { expect(pearson([1, 2, 3], [3, 2, 1])).toBeNull(); });
  it('null when a series has zero variance', () => { const x = lin(12, (i) => i); expect(pearson(x, lin(12, () => 5))).toBeNull(); });
});

describe('correlationMatrix', () => {
  it('symmetric with diagonal 1; uses last `window` obs', () => {
    const a = Array.from({ length: 20 }, (_, i) => i);
    const b = a.map((v) => -v);
    const m = correlationMatrix([a, b], 60); // window > length → uses all 20
    expect(m[0]![0]).toBe(1);
    expect(m[1]![1]).toBe(1);
    expect(m[0]![1]!).toBeCloseTo(-1);
    expect(m[0]![1]).toBeCloseTo(m[1]![0]!); // symmetric
  });
  it('null cells when window too short', () => {
    const a = [1, 2, 3], b = [3, 2, 1];
    const m = correlationMatrix([a, b], 60);
    expect(m[0]![1]).toBeNull();
    expect(m[0]![0]).toBe(1); // diagonal still 1
  });
});
