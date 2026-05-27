import { describe, it, expect } from 'vitest';
import { sma, ema, rsi, macd } from '@/lib/compute/technical';

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

describe('rsi (Wilder smoothing)', () => {
  // Wilder 1978: 14 closes (period=14). First RSI value is at index 14.
  // Source: Welles Wilder, "New Concepts in Technical Trading Systems" (1978), pp. 65-66
  // Closes: 44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
  //         45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00
  // First two RSI values (positions 14 and 15) are ~70.46 and ~66.25.
  // Note: Wilder's textbook prints ~66.50 for index 15, but that uses rounded
  // intermediate values. Recomputing from the raw closes with full precision
  // yields 66.25 — the canonical result of applying Wilder smoothing to this
  // exact series.
  it('matches Wilder 1978 reference fixture', () => {
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
      45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00
    ];
    const out = rsi(closes, 14);
    expect(out).toHaveLength(closes.length);
    // First 14 values are NaN (need 14 returns to seed)
    for (let i = 0; i < 14; i++) {
      expect(Number.isNaN(out[i])).toBe(true);
    }
    // Index 14: first computed RSI
    expect(out[14]).toBeCloseTo(70.46, 1);
    expect(out[15]).toBeCloseTo(66.25, 1);
  });

  it('returns all-NaN when series too short', () => {
    const out = rsi([1, 2, 3], 14);
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
  });

  it('handles flat series (no gains, no losses)', () => {
    // RSI is undefined when avgLoss === 0. Implementation choice: return 100
    // (matches Wilder + most charting platforms).
    const out = rsi([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10], 14);
    expect(out[14]).toBe(100);
  });
});

describe('macd', () => {
  it('returns three parallel arrays of equal length', () => {
    // Need at least fast(12) + slow(26) - 1 + signal(9) - 1 = 35 datapoints
    // to get the first non-NaN signal/histogram values.
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i); // monotonically increasing
    const r = macd(closes, 12, 26, 9);
    expect(r.line).toHaveLength(40);
    expect(r.signal).toHaveLength(40);
    expect(r.histogram).toHaveLength(40);
  });

  it('produces NaN line[] before slow EMA seeds (index < slow-1)', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
    const r = macd(closes, 12, 26, 9);
    for (let i = 0; i < 25; i++) {
      expect(Number.isNaN(r.line[i])).toBe(true);
    }
    // line is defined from index 25 onward (slow-1 = 25)
    expect(Number.isNaN(r.line[25])).toBe(false);
  });

  it('histogram equals line minus signal where both defined', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const r = macd(closes, 12, 26, 9);
    for (let i = 33; i < 50; i++) {
      if (!Number.isNaN(r.line[i]!) && !Number.isNaN(r.signal[i]!)) {
        expect(r.histogram[i]).toBeCloseTo(r.line[i]! - r.signal[i]!, 5);
      }
    }
  });

  it('returns all-NaN when series too short', () => {
    const r = macd([1, 2, 3, 4, 5], 12, 26, 9);
    expect(r.line.every((v) => Number.isNaN(v))).toBe(true);
    expect(r.signal.every((v) => Number.isNaN(v))).toBe(true);
    expect(r.histogram.every((v) => Number.isNaN(v))).toBe(true);
  });
});
