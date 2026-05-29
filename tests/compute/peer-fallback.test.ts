import { describe, it, expect, vi } from 'vitest';
import { selectFallback, type FallbackLevel, type FilterSet } from '@/lib/compute/peer-fallback';

describe('selectFallback', () => {
  const fullFilters: FilterSet = { country: 'US', sizeBand: { min: 100, max: 1000 } };

  it('returns strict when first attempt yields >= K rows', async () => {
    const tryQuery = vi.fn().mockImplementation(async (filters: FilterSet) => {
      if (filters.country === 'US' && filters.sizeBand) return ['A', 'B', 'C', 'D', 'E'];
      return [];
    });
    const result = await selectFallback({ k: 5, filters: fullFilters, tryQuery });
    expect(result).toEqual({ level: 'strict', tickers: ['A', 'B', 'C', 'D', 'E'] });
    expect(tryQuery).toHaveBeenCalledTimes(1);
  });

  it('falls back to no_country when strict yields < K', async () => {
    const tryQuery = vi.fn().mockImplementation(async (filters: FilterSet) => {
      if (filters.country == null && filters.sizeBand) return ['A', 'B', 'C', 'D', 'E'];
      if (filters.country === 'US' && filters.sizeBand) return ['A'];   // < K
      return [];
    });
    const result = await selectFallback({ k: 5, filters: fullFilters, tryQuery });
    expect(result.level).toBe('no_country');
    expect(result.tickers).toHaveLength(5);
  });

  it('falls back to no_size when no_country still yields < K', async () => {
    const tryQuery = vi.fn().mockImplementation(async (filters: FilterSet) => {
      if (filters.country === 'US' && !filters.sizeBand) return ['A', 'B', 'C', 'D', 'E'];
      if (filters.country == null && filters.sizeBand) return ['A', 'B'];   // < K
      if (filters.country === 'US' && filters.sizeBand) return ['A'];       // < K
      return [];
    });
    const result = await selectFallback({ k: 5, filters: fullFilters, tryQuery });
    expect(result.level).toBe('no_size');
    expect(result.tickers).toHaveLength(5);
  });

  it('falls back to global when no_size still yields < K', async () => {
    const tryQuery = vi.fn().mockImplementation(async (filters: FilterSet) => {
      if (filters.country == null && !filters.sizeBand) return ['A', 'B', 'C', 'D', 'E'];
      return ['A'];   // every level above global returns just 1
    });
    const result = await selectFallback({ k: 5, filters: fullFilters, tryQuery });
    expect(result.level).toBe('global');
    expect(result.tickers).toHaveLength(5);
  });

  it('returns global with whatever it found, even if < K', async () => {
    const tryQuery = vi.fn().mockResolvedValue(['A', 'B']);    // every level returns 2
    const result = await selectFallback({ k: 5, filters: fullFilters, tryQuery });
    expect(result.level).toBe('global');
    expect(result.tickers).toEqual(['A', 'B']);
  });

  it('strict accepts boundary K exactly', async () => {
    const tryQuery = vi.fn().mockImplementation(async () => ['A', 'B', 'C', 'D', 'E']);
    const result = await selectFallback({ k: 5, filters: fullFilters, tryQuery });
    expect(result.level).toBe('strict');
  });

  it('dedupes identical attempts when target has null country', async () => {
    const tryQuery = vi.fn().mockResolvedValue(['A']);   // 1 result, below K=5
    const result = await selectFallback({
      k: 5,
      filters: { country: null, sizeBand: { min: 100, max: 1000 } },
      tryQuery
    });
    // strict & no_country are identical (country=null); should call only 2 distinct attempts
    expect(tryQuery).toHaveBeenCalledTimes(2);
    expect(result.level).toBe('no_size');   // the second distinct level
  });

  it('dedupes all attempts when both country and sizeBand are null', async () => {
    const tryQuery = vi.fn().mockResolvedValue(['A']);
    const result = await selectFallback({
      k: 5,
      filters: { country: null, sizeBand: null },
      tryQuery
    });
    // All 4 attempts collapse to one; only one call fires; label is 'strict'
    expect(tryQuery).toHaveBeenCalledTimes(1);
    expect(result.level).toBe('strict');
  });

  it('annotates errors with the level at which tryQuery failed', async () => {
    const tryQuery = vi.fn().mockRejectedValue(new Error('DB timeout'));
    await expect(
      selectFallback({
        k: 5,
        filters: { country: 'US', sizeBand: { min: 100, max: 1000 } },
        tryQuery
      })
    ).rejects.toThrow(/level "strict"/);
  });
});

describe('FallbackLevel type', () => {
  it('has the expected literal values', () => {
    const levels: FallbackLevel[] = ['strict', 'no_country', 'no_size', 'global'];
    expect(levels).toHaveLength(4);
  });
});
