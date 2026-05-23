import { describe, it, expect } from 'vitest';
import {
  computePE,
  computePS,
  computePB,
  computeEVtoEBITDA,
  computePEG
} from '@/lib/compute/multiples';

describe('multiples', () => {
  describe('P/E', () => {
    it('returns price / EPS when both positive', () => {
      expect(computePE(150, 6)).toBeCloseTo(25);
    });
    it('returns null when EPS is zero', () => {
      expect(computePE(150, 0)).toBeNull();
    });
    it('returns null when EPS is negative', () => {
      // P/E is undefined for negative earnings; never return a negative ratio.
      expect(computePE(150, -2)).toBeNull();
    });
    it('returns null when inputs missing', () => {
      expect(computePE(null, 6)).toBeNull();
      expect(computePE(150, null)).toBeNull();
    });
  });

  describe('P/S', () => {
    it('returns market cap / revenue', () => {
      expect(computePS(1000, 250)).toBeCloseTo(4);
    });
    it('returns null when revenue is zero', () => {
      expect(computePS(1000, 0)).toBeNull();
    });
  });

  describe('P/B', () => {
    it('returns market cap / book value', () => {
      expect(computePB(800, 200)).toBeCloseTo(4);
    });
    it('returns null when book value <= 0', () => {
      expect(computePB(800, 0)).toBeNull();
      expect(computePB(800, -50)).toBeNull();
    });
  });

  describe('EV/EBITDA', () => {
    it('returns EV / EBITDA when both positive', () => {
      expect(computeEVtoEBITDA(1200, 100)).toBeCloseTo(12);
    });
    it('returns null when EBITDA <= 0', () => {
      expect(computeEVtoEBITDA(1200, 0)).toBeNull();
      expect(computeEVtoEBITDA(1200, -50)).toBeNull();
    });
  });

  describe('PEG', () => {
    it('returns P/E divided by growth percentage', () => {
      expect(computePEG(20, 10)).toBeCloseTo(2);
    });
    it('returns null when growth is zero or negative', () => {
      expect(computePEG(20, 0)).toBeNull();
      expect(computePEG(20, -5)).toBeNull();
    });
    it('returns null when P/E is null', () => {
      expect(computePEG(null, 10)).toBeNull();
    });
  });
});
