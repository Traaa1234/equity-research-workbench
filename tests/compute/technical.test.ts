import { describe, it, expect } from 'vitest';
import { sma, ema, rsi, macd, detectSignals, computeTechnical } from '@/lib/compute/technical';
import type { PricePoint } from '@/lib/providers/types';

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

function fakePrices(closes: number[]): PricePoint[] {
  // Generate dates 2025-01-01 onward (calendar days, not trading days — fine for tests)
  return closes.map((close, i) => {
    const d = new Date(2025, 0, 1 + i);
    const date = d.toISOString().slice(0, 10);
    return { date, open: close, high: close, low: close, close, adjClose: close, volume: 1000 };
  });
}

describe('detectSignals', () => {
  it('detects golden cross when 50-SMA crosses above 200-SMA', () => {
    // Down for 250 days, then up for 100 — guarantees the 50-SMA dives below 200,
    // then the 50-SMA recovers and crosses back above.
    const closes = [
      ...Array.from({ length: 250 }, (_, i) => 200 - i * 0.5),  // 200 → 75
      ...Array.from({ length: 100 }, (_, i) => 75 + i * 2)       // 75 → 273
    ];
    const prices = fakePrices(closes);
    const computed = computeTechnical(prices);
    const goldens = computed.signals.filter((s) => s.kind === 'golden_cross');
    expect(goldens.length).toBeGreaterThanOrEqual(1);
  });

  it('detects rsi_overbought as a transition only, not while staying above 70', () => {
    // Strongly trending up to push RSI > 70 and keep it there
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i * 2);
    const prices = fakePrices(closes);
    const computed = computeTechnical(prices);
    const overboughts = computed.signals.filter((s) => s.kind === 'rsi_overbought');
    // Should be exactly ONE event (the transition), not many
    expect(overboughts.length).toBe(1);
  });

  it('returns signals sorted by date descending', () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 10) * 50);
    const prices = fakePrices(closes);
    const computed = computeTechnical(prices);
    for (let i = 1; i < computed.signals.length; i++) {
      expect(computed.signals[i - 1]!.date >= computed.signals[i]!.date).toBe(true);
    }
  });
});

describe('computeTechnical (integration)', () => {
  it('handles short series gracefully (no NaN crash)', () => {
    const prices = fakePrices([100, 101, 102, 99, 98]);
    const r = computeTechnical(prices);
    expect(r.sma20).toHaveLength(5);
    expect(r.current.sma20).toBeNull();
    expect(r.current.sma50).toBeNull();
    expect(r.current.sma200).toBeNull();
    expect(r.current.rsi).toBeNull();
    expect(r.current.price).toBe(98);
    expect(r.signals).toEqual([]);
  });

  it('produces current readings for a full-1Y series', () => {
    // 251 trading days at constant 100 then trending up — guarantees SMAs and RSI populate
    const closes = [
      ...Array.from({ length: 200 }, () => 100),
      ...Array.from({ length: 51 }, (_, i) => 100 + i)
    ];
    const prices = fakePrices(closes);
    const r = computeTechnical(prices);
    expect(r.current.sma20).not.toBeNull();
    expect(r.current.sma50).not.toBeNull();
    expect(r.current.sma200).not.toBeNull();
    expect(r.current.rsi).not.toBeNull();
    expect(r.current.macdHistogram).not.toBeNull();
    expect(r.current.price).toBe(150);
  });
});
