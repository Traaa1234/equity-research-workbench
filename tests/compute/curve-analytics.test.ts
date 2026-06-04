import { describe, it, expect } from 'vitest';
import { classifyShape, spreadSeries, momentumTag, recessionSignal, lastSignChangeMonths, spreadBadge, buildCurve } from '@/lib/compute/curve-analytics';

const s = (vals: [string, number][]) => vals.map(([date, value]) => ({ date, value }));

describe('classifyShape', () => {
  const y = (o: Partial<Record<string, number>>) => o as Record<string, number>;
  it('INVERTED when both 3m10y and 2s10s < 0', () => {
    expect(classifyShape(y({ DGS3MO: 5.3, DGS2: 4.8, DGS5: 4.4, DGS10: 4.5, DGS30: 4.6 }))).toBe('INVERTED');
  });
  it('PARTIALLY_INVERTED when exactly one < 0', () => {
    expect(classifyShape(y({ DGS3MO: 4.3, DGS2: 3.85, DGS5: 3.9, DGS10: 4.1, DGS30: 4.5 }))).toBe('PARTIALLY_INVERTED');
  });
  it('FLAT when |10Y-3M| < 0.25 and not inverted', () => {
    expect(classifyShape(y({ DGS3MO: 4.0, DGS2: 4.0, DGS5: 4.05, DGS10: 4.1, DGS30: 4.15 }))).toBe('FLAT');
  });
  it('HUMPED when belly above both ends (and not inverted)', () => {
    expect(classifyShape(y({ DGS3MO: 3.5, DGS2: 4.0, DGS5: 4.3, DGS10: 4.1, DGS30: 3.9 }))).toBe('HUMPED');
  });
  it('NORMAL otherwise (positive slope)', () => {
    expect(classifyShape(y({ DGS3MO: 3.5, DGS2: 3.7, DGS5: 3.9, DGS10: 4.2, DGS30: 4.5 }))).toBe('NORMAL');
  });
});

describe('spreads + momentum', () => {
  it('spreadSeries pairs by date and subtracts', () => {
    const long = s([['2026-01-01', 4.1], ['2026-02-01', 4.2]]);
    const short = s([['2026-01-01', 3.8], ['2026-02-01', 4.0]]);
    expect(spreadSeries(long, short)).toEqual([{ date: '2026-01-01', value: 4.1 - 3.8 }, { date: '2026-02-01', value: 4.2 - 4.0 }]);
  });
  it('momentumTag from 2s10s 3-mo change', () => {
    expect(momentumTag(s([['2026-01-01', -0.2], ['2026-04-01', 0.1]]))).toBe('steepening');
    expect(momentumTag(s([['2026-01-01', 0.3], ['2026-04-01', 0.0]]))).toBe('flattening');
    expect(momentumTag(s([['2026-01-01', 0.2], ['2026-04-01', 0.22]]))).toBe('stable');
  });
  it('spreadBadge bands', () => {
    expect(spreadBadge(-0.1)).toBe('INVERTED');
    expect(spreadBadge(0.1)).toBe('FLAT');
    expect(spreadBadge(0.4)).toBe('POSITIVE');
    expect(spreadBadge(0.7)).toBe('STEEP');
  });
});

describe('recession signal + duration', () => {
  it('ON when both inverted', () => {
    expect(recessionSignal(s([['2025-01-01', -0.3], ['2026-01-01', -0.2]]), s([['2025-01-01', -0.1], ['2026-01-01', -0.05]])).level).toBe('ON');
  });
  it('CAUTION when one inverted', () => {
    expect(recessionSignal(s([['2026-01-01', -0.2]]), s([['2026-01-01', 0.25]])).level).toBe('CAUTION');
  });
  it('WATCH when positive now but inverted within ~6mo', () => {
    const s3 = s([['2026-01-01', -0.2], ['2026-02-01', -0.1], ['2026-04-01', 0.1]]);
    const s2 = s([['2026-01-01', 0.1], ['2026-04-01', 0.3]]);
    expect(recessionSignal(s3, s2).level).toBe('WATCH');
  });
  it('CLEAR when positive and not recently inverted', () => {
    const s3 = s([['2024-01-01', 0.5], ['2026-04-01', 0.6]]);
    expect(recessionSignal(s3, s3).level).toBe('CLEAR');
  });
  it('lastSignChangeMonths counts inversion duration from streak start', () => {
    const r = lastSignChangeMonths(s([['2025-01-01', 0.2], ['2025-04-01', -0.1], ['2026-01-01', -0.2]]));
    expect(r.invertedNow).toBe(true);
    expect(r.monthsInverted).toBe(9); // streak began 2025-04 → 2026-01
  });
});

describe('buildCurve', () => {
  it('assembles maturities + spreads + read from histories', () => {
    const h = (v: number) => s([['2025-06-01', v - 0.1], ['2026-06-01', v]]);
    const histories: Record<string, { date: string; value: number }[]> = {
      DGS3MO: h(4.3), DGS6MO: h(4.2), DGS1: h(4.0), DGS2: h(3.85), DGS5: h(3.9), DGS7: h(4.0), DGS10: h(4.1), DGS20: h(4.45), DGS30: h(4.5),
    };
    const c = buildCurve(histories);
    expect(c.maturities).toHaveLength(9);
    expect(c.maturities.find((m) => m.seriesId === 'DGS10')!.current).toBeCloseTo(4.1);
    expect(c.spreads).toHaveLength(3);
    expect(c.read.shape).toBe('PARTIALLY_INVERTED');
  });
});
