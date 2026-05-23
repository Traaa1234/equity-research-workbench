import { describe, it, expect } from 'vitest';
import { computeROE, computeROA, computeROIC } from '@/lib/compute/returns';

describe('ROE', () => {
  it('returns net income / equity', () => {
    expect(computeROE(50, 250)).toBeCloseTo(0.2);
  });
  it('returns null when equity <= 0', () => {
    expect(computeROE(50, 0)).toBeNull();
    expect(computeROE(50, -10)).toBeNull();
  });
});

describe('ROA', () => {
  it('returns net income / total assets', () => {
    expect(computeROA(50, 500)).toBeCloseTo(0.1);
  });
  it('returns null when assets <= 0', () => {
    expect(computeROA(50, 0)).toBeNull();
  });
});

describe('ROIC', () => {
  it('returns NOPAT / invested capital', () => {
    // NOPAT = operating income * (1 - tax rate)
    // operatingIncome=100, taxRate=0.25 → NOPAT = 75; investedCapital=500 → ROIC = 0.15
    expect(computeROIC(100, 0.25, 500)).toBeCloseTo(0.15);
  });
  it('returns null when invested capital <= 0', () => {
    expect(computeROIC(100, 0.25, 0)).toBeNull();
  });
  it('returns null for tax rate outside [0,1]', () => {
    expect(computeROIC(100, -0.1, 500)).toBeNull();
    expect(computeROIC(100, 1.1, 500)).toBeNull();
  });
});
