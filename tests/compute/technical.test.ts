import { describe, it, expect } from 'vitest';
import { sma, ema } from '@/lib/compute/technical';

describe('sma', () => {
  it('returns rolling mean with NaN padding before period', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBeCloseTo(2);
    expect(out[3]).toBeCloseTo(3);
    expect(out[4]).toBeCloseTo(4);
  });

  it('returns all-NaN when series shorter than period', () => {
    const out = sma([1, 2], 5);
    expect(out).toHaveLength(2);
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
  });

  it('handles period=1 as identity', () => {
    expect(sma([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });
});

describe('ema', () => {
  it('seeds at index period-1 with SMA, then recurses', () => {
    // Period=3, k = 2/(3+1) = 0.5
    // Seed at index 2 = mean(1,2,3) = 2
    // ema[3] = 4*0.5 + 2*0.5 = 3
    // ema[4] = 5*0.5 + 3*0.5 = 4
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(out[0])).toBe(true);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBeCloseTo(2);
    expect(out[3]).toBeCloseTo(3);
    expect(out[4]).toBeCloseTo(4);
  });

  it('returns all-NaN when series shorter than period', () => {
    const out = ema([1, 2], 5);
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
  });
});
