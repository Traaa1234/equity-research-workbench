import { describe, it, expect } from 'vitest';
import { computeYoY, computeCAGR } from '@/lib/compute/growth';

describe('YoY growth', () => {
  it('returns positive pct when value grew', () => {
    expect(computeYoY(110, 100)).toBeCloseTo(0.1);
  });
  it('returns negative pct when value shrank', () => {
    expect(computeYoY(80, 100)).toBeCloseTo(-0.2);
  });
  it('returns null when prior is zero (undefined growth)', () => {
    expect(computeYoY(100, 0)).toBeNull();
  });
  it('handles negative prior by returning null', () => {
    // Sign-flip cases are confusing; refuse to compute.
    expect(computeYoY(100, -50)).toBeNull();
  });
  it('returns null when inputs missing', () => {
    expect(computeYoY(null, 100)).toBeNull();
    expect(computeYoY(100, null)).toBeNull();
  });
});

describe('CAGR', () => {
  it('returns annualized growth over multiple years', () => {
    // 100 → 200 over 5y → ~14.87%
    expect(computeCAGR(200, 100, 5)).toBeCloseTo(0.1487, 3);
  });
  it('returns 0 when start and end equal', () => {
    expect(computeCAGR(100, 100, 5)).toBeCloseTo(0);
  });
  it('returns null when years is zero', () => {
    expect(computeCAGR(200, 100, 0)).toBeNull();
  });
  it('returns null when start is non-positive', () => {
    expect(computeCAGR(200, 0, 5)).toBeNull();
    expect(computeCAGR(200, -10, 5)).toBeNull();
  });
  it('returns null when inputs missing', () => {
    expect(computeCAGR(null, 100, 5)).toBeNull();
  });
});
