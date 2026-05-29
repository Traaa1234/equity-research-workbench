import { describe, it, expect } from 'vitest';
import { quartileClass, type QuartileDirection } from '@/lib/compute/quartile-helpers';

describe('quartileClass', () => {
  it('higher-is-better: top quartile gets green', () => {
    const values = [10, 20, 30, 40];   // 40 is best
    expect(quartileClass(40, values, 'higher-is-better')).toBe('text-emerald-600');
    expect(quartileClass(10, values, 'higher-is-better')).toBe('text-rose-600');
  });

  it('lower-is-better: bottom quartile gets green', () => {
    const values = [10, 20, 30, 40];   // 10 is best (cheapest)
    expect(quartileClass(10, values, 'lower-is-better')).toBe('text-emerald-600');
    expect(quartileClass(40, values, 'lower-is-better')).toBe('text-rose-600');
  });

  it('null value returns empty class', () => {
    const values = [10, 20, 30];
    expect(quartileClass(null, values, 'higher-is-better')).toBe('');
  });

  it('all-null peer set returns empty class', () => {
    expect(quartileClass(5, [null, null, null], 'higher-is-better')).toBe('');
  });

  it('single-value peer set returns neutral class', () => {
    expect(quartileClass(42, [42], 'higher-is-better')).toBe('');
  });

  it('middle quartiles get neutral class', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80];
    expect(quartileClass(30, values, 'higher-is-better')).toBe('');
    expect(quartileClass(50, values, 'higher-is-better')).toBe('');
  });

  it('ties are handled deterministically (first occurrence wins)', () => {
    const values = [10, 10, 20, 30];
    // Two values tied at 10. With higher-is-better, both 10s land in bottom quartile.
    expect(quartileClass(10, values, 'higher-is-better')).toBe('text-rose-600');
  });

  it('NaN value returns neutral', () => {
    expect(quartileClass(NaN, [10, 20, 30, 40], 'higher-is-better')).toBe('');
    expect(quartileClass(NaN, [10, 20, 30, 40], 'lower-is-better')).toBe('');
  });

  it('Infinity value returns neutral', () => {
    expect(quartileClass(Infinity, [10, 20, 30, 40], 'higher-is-better')).toBe('');
    expect(quartileClass(-Infinity, [10, 20, 30, 40], 'lower-is-better')).toBe('');
  });
});

describe('QuartileDirection type', () => {
  it('compiles with both literal values', () => {
    const a: QuartileDirection = 'higher-is-better';
    const b: QuartileDirection = 'lower-is-better';
    expect([a, b]).toEqual(['higher-is-better', 'lower-is-better']);
  });
});
